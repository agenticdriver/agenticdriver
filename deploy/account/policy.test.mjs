import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HostConfigSchema } from "../../dist/host.js";
import { validateAccountDeployment } from "./host.mjs";

const example = JSON.parse(
  await readFile(new URL("./config.example.json", import.meta.url), "utf8"),
);
// Pure configuration checks: no provider process, invented connection or model response.
test("the documented one-account configuration passes the actual host schema", () => {
  assert.equal(
    validateAccountDeployment(HostConfigSchema.parse(example)).providers.length,
    1,
  );
});
test("account policy rejects shared homes, extra accounts, broad grants and state paths", () => {
  const mutations = [
    (c) => c.providers.push({ ...c.providers[0], id: "other-account" }),
    (c) => (c.providers[0].accountDirectory = "/home/host/.codex"),
    (c) => (c.providers[0].binary = "/tmp/alternate-binary"),
    (c) => c.tokens[0].providers.push("other-account"),
    (c) => (c.tokens[0].providers = []),
    (c) => (c.tokens[0].manageProviders = true),
    (c) => (c.tokens[0].tokenRef = { file: "/home/host/token" }),
    (c) => (c.listen.host = "0.0.0.0"),
    (c) => (c.usageLog = "/home/host/usage.jsonl"),
    (c) => (c.operations.directory = "/home/host/operations"),
    (c) => delete c.providers[0].accountId,
    (c) => (c.providers[0].kind = "unregistered"),
  ];
  for (const mutate of mutations) {
    const config = structuredClone(example);
    mutate(config);
    assert.throws(() => validateAccountDeployment(config));
  }
});
