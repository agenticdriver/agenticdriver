import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { AgenticDriver } from "/tmp/fixture-sdk/dist/index.js";
import { claudeCode } from "/tmp/fixture-sdk/dist/providers/index.js";

const root = "/tmp/fixture-work";
const signedIn = `${root}/signed-in`, signedOut = `${root}/signed-out`;
for (const path of [signedIn, signedOut]) await mkdir(path, { recursive: true });
await writeFile(`${signedIn}/.credentials.json`, JSON.stringify({
  claudeAiOauth: {
    accessToken: "synthetic-catalog-token-never-valid",
    refreshToken: "synthetic-catalog-refresh-never-valid",
    expiresAt: Date.now() + 86_400_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
}), { mode: 0o600 });
const marker = `${root}/ambient-executed`;
await writeFile(`${signedIn}/settings.json`, JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
  fallbackModel: ["other-fixture-model"],
  switchModelsOnFlag: true,
}), { mode: 0o600 });
await writeFile(`${signedIn}/.claude.json`, JSON.stringify({
  mcpServers: { ambient: { command: "/usr/bin/touch", args: [marker] } },
}), { mode: 0o600 });
const driver = new AgenticDriver({
  discovery: { timeoutMs: 12_000, minRefreshMs: 0 },
  providers: [
    claudeCode({ id: "signed-in", binary: "/tmp/fixture-claude", accountDirectory: signedIn, models: [] }),
    claudeCode({ id: "signed-out", binary: "/tmp/fixture-claude", accountDirectory: signedOut }),
  ],
});
const [available, missing] = await driver.discoverProviders();
assert.equal(available.health.code, "CLI_CATALOG_AVAILABLE");
assert.equal(available.health.status, "unknown");
assert.equal(available.modelCatalog.source, "provider");
assert.equal(available.modelCatalog.complete, true);
assert.ok(available.modelCatalog.models.length >= 1);
assert.deepEqual(available.models, []);
assert.equal(missing.health.code, "CLI_AUTH_REQUIRED");
assert.equal(missing.modelCatalog.complete, false);
await assert.rejects(access(marker));
console.log(JSON.stringify({
  nativeVersion: "2.1.282", passed: true, promptSubmitted: false,
  realCredentials: false, externalNetwork: false,
  signedInCode: available.health.code, signedOutCode: missing.health.code,
  modelCount: available.modelCatalog.models.length,
  models: available.modelCatalog.models, allowlistUnchanged: true,
  ambientHooksAndMcpStarted: false,
}));
