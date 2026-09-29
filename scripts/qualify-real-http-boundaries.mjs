// Negative requests target the actual authenticated SDK host, never a model substitute.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AgenticClient } from "@agenticdriver/sdk/client";
import {
  connectedClient,
  readConnectionProfile,
} from "@agenticdriver/sdk/connections";
const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    administrator: { type: "string" },
    restricted: { type: "string" },
    "run-receipt": { type: "string" },
    receipt: { type: "string" },
  },
});
for (const name of [
  "owner",
  "administrator",
  "restricted",
  "run-receipt",
  "receipt",
])
  if (!values[name]) throw new Error(`Provide --${name}.`);
const file = await open(values.receipt, "wx", 0o600);
const receipt = {
  startedAt: new Date().toISOString(),
  checks: {},
  modelRequests: 0,
};
try {
  const profile = await readConnectionProfile(values.owner);
  const token = (
    await readFile(join(dirname(values.owner), profile.tokenFile), "utf8")
  ).trim();
  const owner = await connectedClient(values.owner),
    admin = await connectedClient(values.administrator),
    restricted = await connectedClient(values.restricted);
  async function rejected(name, path, options, code, status) {
    const response = await fetch(new URL(path, profile.url), {
      redirect: "error",
      ...options,
    });
    const text = await response.text();
    assert(!text.includes(token));
    assert.equal(response.status, status);
    const body = JSON.parse(text);
    assert.equal(body.error.code, code);
    receipt.checks[name] = { status: response.status, code: body.error.code };
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  await rejected("missingBearer", "v1/protocol", {}, "UNAUTHORIZED", 401);
  await rejected(
    "browserOrigin",
    "v1/protocol",
    { headers: { ...headers, origin: "https://unapproved.invalid" } },
    "ORIGIN_DENIED",
    403,
  );
  await rejected(
    "cookieDoesNotAuthenticate",
    "v1/protocol",
    { headers: { cookie: "agenticdriver=not-a-driver-credential" } },
    "UNAUTHORIZED",
    401,
  );
  await rejected(
    "invalidUtf8",
    "v1/runs",
    {
      method: "POST",
      headers,
      body: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
    },
    "INVALID_REQUEST",
    400,
  );
  await rejected(
    "oversizedBody",
    "v1/runs",
    { method: "POST", headers, body: " ".repeat(1_000_001) },
    "BODY_TOO_LARGE",
    413,
  );
  await rejected(
    "unsupportedVersion",
    "v1/protocol",
    { headers: { ...headers, "AgenticDriver-Version": "9.9" } },
    "UNSUPPORTED_PROTOCOL_VERSION",
    400,
  );
  await assert.rejects(owner.connections(), { code: "FORBIDDEN" });
  receipt.checks.executionDoesNotGrantManagement = true;
  const original = JSON.parse(await readFile(values["run-receipt"], "utf8"));
  await assert.rejects(
    admin.run({
      provider: original.request.provider,
      model: original.request.model,
      input: "Review the selected release criteria.",
    }),
    { code: "FORBIDDEN" },
  );
  receipt.checks.managementDoesNotGrantExecution = true;
  const denied = {
    ...original.request,
    idempotencyKey: undefined,
    metadata: { subject: "rc-tool-owner", approveTools: "read_release_note" },
  };
  await assert.rejects(
    async () => {
      for await (const _event of restricted.stream(denied)) {
        throw new Error("An unauthorized run started.");
      }
    },
    { code: "FORBIDDEN" },
  );
  receipt.checks.metadataDoesNotGrantTools = true;
  await assert.rejects(
    owner.searchContext({
      corpus: "release-library",
      sourceIds: ["paper"],
      query: "What does the public paper report?",
    }),
    { code: "FORBIDDEN" },
  );
  receipt.checks.executionDoesNotGrantRetrieval = true;
  const invitation = await admin.createInvitation({
    grant: { subject: "rc-revocation-check", providers: [] },
    connectionLifetimeSeconds: 60,
  });
  const exchanging = new AgenticClient({
    url: profile.url,
    token: invitation.code,
  });
  const credentials = await exchanging.exchangeConnection();
  await assert.rejects(exchanging.exchangeConnection(), {
    code: "INVITATION_REJECTED",
  });
  const paired = new AgenticClient({
    url: profile.url,
    token: credentials.token,
  });
  assert.deepEqual(await paired.providers(), []);
  assert.equal((await admin.revokeConnection(credentials.id)).revoked, true);
  await assert.rejects(paired.providers(), { code: "UNAUTHORIZED" });
  receipt.checks.oneUsePairingAndRevocation = {
    id: credentials.id,
    replayCode: "INVITATION_REJECTED",
    revokedCode: "UNAUTHORIZED",
  };
  receipt.success = true;
  console.log(
    JSON.stringify({
      success: true,
      checks: Object.keys(receipt.checks),
      modelRequests: 0,
    }),
  );
} catch (error) {
  receipt.success = false;
  receipt.error = { code: error.code, message: error.message };
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  await file.close();
}
