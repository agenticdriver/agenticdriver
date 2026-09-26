import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexDeviceSignIn } from "../src/providers/codex-sign-in.js";

const qualified = process.platform === "linux" && process.arch === "x64";
async function fixture(mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "codex-sign-in-"));
  const account = join(root, "account"),
    binary = join(root, "native-fixture");
  await mkdir(account, { mode: 0o700 });
  await writeFile(
    binary,
    `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.157.0');process.exit(0);}
const mode=${JSON.stringify(mode)},home=process.env.CODEX_HOME;
const methods=[];let pending='';
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
const loginId='11111111-1111-4111-8111-111111111111';
process.stdin.on('data',(chunk)=>{pending+=chunk;const lines=pending.split('\\n');pending=lines.pop();for(const line of lines){if(!line)continue;const m=JSON.parse(line);methods.push(m.method);fs.writeFileSync(home+'/methods.json',JSON.stringify(methods));
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:m.id===2?null:(mode==='unverified'?null:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}),requiresOpenaiAuth:true,workspaceRouting:{chatgptAccountId:'synthetic'}}});
 else if(m.method==='account/login/start'){
  fs.writeFileSync(home+'/environment.json',JSON.stringify({issuerPresent:!!process.env.CODEX_APP_SERVER_LOGIN_ISSUER,apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  const note={method:'account/login/completed',params:{loginId:mode==='wrong-login'?'22222222-2222-4222-8222-222222222222':loginId,success:true}};
  if(mode==='early-notification')send(note);
  send({id:m.id,result:{type:'chatgptDeviceCode',loginId,userCode:'TEST-ONLY',verificationUrl:mode==='unsafe-url'?'https://attacker.invalid/codex/device':'https://auth.openai.com/codex/device'}});
  if(!['wait','early-notification'].includes(mode))send(note);
 }
}});
`,
    { mode: 0o700 },
  );
  return {
    root,
    account,
    binary,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test(
  "owned native sign-in verifies the account, accepts early completion and sends no thread/model calls",
  { skip: !qualified },
  async () => {
    for (const mode of ["success", "early-notification"]) {
      const f = await fixture(mode);
      const oldIssuer = process.env.CODEX_APP_SERVER_LOGIN_ISSUER;
      const oldKey = process.env.OPENAI_API_KEY;
      process.env.CODEX_APP_SERVER_LOGIN_ISSUER = "https://untrusted.invalid";
      process.env.OPENAI_API_KEY = "synthetic-key-must-not-reach-child";
      try {
        let interaction = false,
          verifying = false;
        const account = await codexDeviceSignIn({
          binary: f.binary,
          accountDirectory: f.account,
          signal: AbortSignal.timeout(10_000),
          interaction(value) {
            interaction = true;
            assert.equal(
              value.verificationUrl,
              "https://auth.openai.com/codex/device",
            );
          },
          verifying() {
            verifying = true;
          },
        });
        assert.deepEqual(account, {
          email: "fixture@example.invalid",
          plan: "plus",
          providerAccountId: "synthetic",
        });
        assert(interaction && verifying);
        assert.deepEqual(
          JSON.parse(await readFile(join(f.account, "methods.json"), "utf8")),
          [
            "initialize",
            "initialized",
            "account/read",
            "account/login/start",
            "account/read",
          ],
        );
        assert.deepEqual(
          JSON.parse(
            await readFile(join(f.account, "environment.json"), "utf8"),
          ),
          { issuerPresent: false, apiKeyPresent: false },
        );
      } finally {
        if (oldIssuer === undefined)
          delete process.env.CODEX_APP_SERVER_LOGIN_ISSUER;
        else process.env.CODEX_APP_SERVER_LOGIN_ISSUER = oldIssuer;
        if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = oldKey;
        await f.cleanup();
      }
    }
  },
);
test(
  "native sign-in rejects foreign login notifications, untrusted URLs and completion without a verified account",
  { skip: !qualified },
  async () => {
    for (const mode of ["wrong-login", "unsafe-url", "unverified"]) {
      const f = await fixture(mode);
      try {
        await assert.rejects(
          codexDeviceSignIn({
            binary: f.binary,
            accountDirectory: f.account,
            signal: AbortSignal.timeout(10_000),
            interaction() {},
            verifying() {},
          }),
          { code: "SETUP_PROTOCOL_ERROR" },
        );
      } finally {
        await f.cleanup();
      }
    }
  },
);
test(
  "native sign-in never overwrites a populated profile and cancellation ends only its owned process",
  { skip: !qualified },
  async () => {
    const existing = await fixture();
    try {
      await writeFile(
        join(existing.account, "auth.json"),
        "synthetic-existing-credential",
      );
      await assert.rejects(
        codexDeviceSignIn({
          binary: existing.binary,
          accountDirectory: existing.account,
          signal: new AbortController().signal,
          interaction() {},
          verifying() {},
        }),
        { code: "SETUP_PROFILE_UNSAFE" },
      );
      assert.equal(
        await readFile(join(existing.account, "auth.json"), "utf8"),
        "synthetic-existing-credential",
      );
    } finally {
      await existing.cleanup();
    }
    const waiting = await fixture("wait"),
      abort = new AbortController();
    try {
      await assert.rejects(
        codexDeviceSignIn({
          binary: waiting.binary,
          accountDirectory: waiting.account,
          signal: abort.signal,
          interaction() {
            abort.abort();
          },
          verifying() {
            assert.fail("Cancelled login cannot verify");
          },
        }),
        { code: "CANCELLED" },
      );
    } finally {
      await waiting.cleanup();
    }
  },
);
