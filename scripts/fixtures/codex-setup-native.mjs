// Real Codex device authentication + production SDK lifecycle. The harness hides the
// real home and disables external networking. Nothing here is a live account check.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { managedHost } from "/tmp/fixture-sdk/dist/management.js";
import { AgenticClient } from "/tmp/fixture-sdk/dist/client.js";
import { serve } from "/tmp/fixture-sdk/dist/server.js";

const root = "/tmp/fixture-work",
  paths = [];
let authorized = false;
const payload = {
  email: "device@example.invalid",
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": {
    chatgpt_account_id: "synthetic-device-account",
    chatgpt_plan_type: "plus",
  },
};
const jwt =
  Buffer.from('{"alg":"none"}').toString("base64url") +
  "." +
  Buffer.from(JSON.stringify(payload)).toString("base64url") +
  ".synthetic";
const issuerServer = createServer(async (req, res) => {
  paths.push(req.url);
  for await (const _chunk of req) {
  } // Never retain credential headers or exchange bodies.
  let body;
  if (req.url === "/api/accounts/deviceauth/usercode")
    body = {
      device_auth_id: "synthetic-only",
      user_code: "TEST-DEVICE",
      interval: "1",
    };
  else if (req.url === "/api/accounts/deviceauth/token") {
    if (!authorized) {
      res.writeHead(403).end("{}");
      return;
    }
    body = {
      authorization_code: "synthetic-code",
      code_challenge: "synthetic-challenge",
      code_verifier: "synthetic-verifier",
    };
  } else if (req.url === "/oauth/token")
    body = {
      access_token: jwt,
      id_token: jwt,
      refresh_token: "synthetic-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    };
  else if (req.url === "/backend-api/wham/accounts/check")
    body = {
      accounts: [
        {
          id: "synthetic-device-account",
          workspace_backend_origin: "https://chatgpt.com",
          account_routing_override: "NO_CONSTRAINT",
        },
      ],
    };
  else if (req.url === "/backend-api/wham/config/bundle") body = {};
  else {
    res.writeHead(404).end("{}");
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(body));
});
issuerServer.listen(0, "127.0.0.1");
await once(issuerServer, "listening");
const issuer = `http://127.0.0.1:${issuerServer.address().port}`;
const wrapper = `${root}/fixture-codex.mjs`,
  journal = `${root}/methods.jsonl`;
// Test-only interposer: native's documented test issuer uses loopback HTTP. Rewrite
// ONLY its returned verification URL to the production allowlisted origin. Actual
// login IDs, completion events, account reads, exchange and private storage are native.
// Production rejects issuer environment overrides and never accepts loopback device URLs.
await writeFile(
  wrapper,
  `#!/tmp/fixture-node
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {appendFileSync} from "node:fs";
import {createInterface} from "node:readline";
const args=process.argv.slice(2), issuer=${JSON.stringify(issuer)};
assert.equal(process.env.CODEX_APP_SERVER_LOGIN_ISSUER, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
if(args[0] === "app-server") args.push("-c", "chatgpt_base_url="+JSON.stringify(issuer+"/backend-api"));
const child=spawn("/tmp/fixture-codex",args,{env:{...process.env,CODEX_APP_SERVER_LOGIN_ISSUER:issuer},stdio:["pipe","pipe","ignore"]});
if(args[0] === "--version") {child.stdout.pipe(process.stdout); child.stdin.end();}
else {
 const input=createInterface({input:process.stdin});
 input.on("line",line=>{const m=JSON.parse(line); assert.ok(["initialize","initialized","account/read","account/login/start"].includes(m.method)); appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method:m.method,home:process.env.CODEX_HOME})+"\\n"); child.stdin.write(line+"\\n");});
 input.on("close",()=>child.stdin.end());
 createInterface({input:child.stdout}).on("line",line=>{const m=JSON.parse(line); if(m.result?.type === "chatgptDeviceCode") {assert.equal(m.result.verificationUrl,issuer+"/codex/device"); m.result.verificationUrl="https://auth.openai.com/codex/device";} process.stdout.write(JSON.stringify(m)+"\\n");});
}
child.on("close",code=>process.exit(code??1));
`,
  { mode: 0o700 },
);

const configPath = `${root}/host.json`;
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    usage: { hostId: "setup-fixture" },
    listen: { port: 0 },
    providers: [],
    tokens: [],
  }),
  { mode: 0o600 },
);
await mkdir(`${root}/shared-account`, { mode: 0o700 });
await writeFile(
  `${root}/shared-account/sentinel`,
  "existing session must survive",
);
const host = await managedHost(configPath);
const token = "owned-setup-native-fixture-token-at-least-32-characters";
const other = "another-setup-native-fixture-token-at-least-32-characters";
const server = await serve(host.driver, {
  port: 0,
  management: host.management,
  tokens: [
    { token, subject: "owner", providers: [], manageProviders: true },
    { token: other, subject: "owner", providers: [], manageProviders: true },
  ],
});
const client = new AgenticClient({ url: server.url, token });
const stranger = new AgenticClient({ url: server.url, token: other });
async function start(id) {
  return (
    await client.providerSetup({
      action: "start",
      method: "codex-device",
      revision: (await client.management()).revision,
      provider: {
        kind: "codex",
        id,
        accountId: `account-${id}`,
        binary: wrapper,
      },
    })
  ).attempts[0];
}
async function phase(id, expected) {
  for (let i = 0; i < 400; i++) {
    const a = (await client.providerSetup({ action: "status", id }))
      .attempts[0];
    if (a.phase === expected) return a;
    assert.ok(
      !["failed", "expired"].includes(a.phase),
      JSON.stringify(a.error),
    );
    await delay(25);
  }
  throw new Error(`Native fixture did not reach ${expected}`);
}
try {
  const cancelled = await start("cancelled");
  await phase(cancelled.id, "waiting");
  await assert.rejects(
    stranger.providerSetup({ action: "cancel", id: cancelled.id }),
    { code: "SETUP_NOT_FOUND" },
  );
  await client.providers({ refresh: true });
  assert.equal(
    (await client.providerSetup({ action: "cancel", id: cancelled.id }))
      .attempts[0].phase,
    "cancelled",
  );
  assert.deepEqual(await readdir(`${root}/provider-accounts`), []);

  const attempt = await start("accepted");
  const waiting = await phase(attempt.id, "waiting");
  assert.equal(waiting.interaction.userCode, "TEST-DEVICE");
  await assert.rejects(
    client.providerSetup({ action: "accept", id: attempt.id }),
    { code: "SETUP_NOT_READY" },
  );
  authorized = true;
  const ready = await phase(attempt.id, "ready");
  assert.equal(ready.account.email, "device@example.invalid");
  assert.equal(ready.account.plan, "plus");
  assert.deepEqual(host.config().providers, []);
  assert.equal(
    (await client.providerSetup({ action: "accept", id: attempt.id }))
      .attempts[0].phase,
    "succeeded",
  );
  const provider = host.config().providers[0];
  assert.equal(provider.accountId, "account-accepted");
  assert.equal(provider.models, undefined);
  assert.equal(
    (await stat(`${provider.accountDirectory}/auth.json`)).mode & 0o077,
    0,
  );
  assert.deepEqual((await client.management()).executionProviders, []);
  await assert.rejects(
    client.providerSetup({ action: "accept", id: attempt.id }),
    { code: "SETUP_FINISHED" },
  );
  authorized = false;
  const shutdown = await start("shutdown");
  await phase(shutdown.id, "waiting");
  await server.close();
  assert.equal((await readdir(`${root}/provider-accounts`)).length, 1);
  assert.equal(
    await readFile(`${root}/shared-account/sentinel`, "utf8"),
    "existing session must survive",
  );
  assert.ok(
    paths.every((p) =>
      [
        "/api/accounts/deviceauth/usercode",
        "/api/accounts/deviceauth/token",
        "/oauth/token",
        "/backend-api/wham/accounts/check",
        "/backend-api/wham/config/bundle",
      ].includes(p),
    ),
  );
  const methods = (await readFile(journal, "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s).method);
  assert.equal(methods.filter((m) => m === "account/login/start").length, 3);
  console.log(
    JSON.stringify({
      version: "0.157.0",
      cases: [
        "native-device-account-verification",
        "explicit-acceptance",
        "caller-binding",
        "cancel-and-shutdown-cleanup",
        "existing-account-preserved",
        "no-execution-grants",
      ],
      providerOwnsExchangeAndStorage: true,
      privateCredentialFile: true,
      modelCalls: 0,
      requestPaths: [...new Set(paths)],
      fixtureSeam:
        "Native loopback test issuer; only verification URL translated to the production allowlisted URL. No live issuer or browser authorization qualified.",
    }),
  );
} finally {
  await server.close();
  issuerServer.closeAllConnections();
  await new Promise((r) => issuerServer.close(r));
}
