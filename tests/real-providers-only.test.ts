import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as providers from "../src/providers/index.js";
import * as retrieval from "../src/retrieval.js";
import { validateHostConfig, configuredDriver } from "../src/host.js";
import { HostProviderConfigSchema } from "../src/provider-config.js";
import { ConfigureProviderSchema } from "../src/management-types.js";
import { providerDefinitions } from "../src/provider-definitions.js";

const run = promisify(execFile);
test("removed providers cannot be selected, configured remotely or imported", () => {
  assert.equal("mockProvider" in providers, false);
  assert.equal("DeterministicEmbeddingAdapter" in retrieval, false);
  assert.equal(
    providerDefinitions().some((p) => p.kind === "mock"),
    false,
  );
  assert.throws(
    () =>
      validateHostConfig({
        version: 1,
        providers: [{ kind: "mock", id: "demo" }],
      }),
    { code: "MOCK_PROVIDER_REMOVED" },
  );
  assert.equal(
    HostProviderConfigSchema.safeParse({ kind: "mock", id: "demo" }).success,
    false,
  );
  assert.equal(
    ConfigureProviderSchema.safeParse({
      revision: "a".repeat(64),
      provider: { kind: "mock", id: "demo" },
    }).success,
    false,
  );
});
test("a fresh empty host has no provider connections", () => {
  const config = validateHostConfig({ version: 1, providers: [] });
  assert.deepEqual(
    configuredDriver(config, "/tmp/unused-config.json").listProviders(),
    [],
  );
});
test("initialization requires a real provider before writing credentials or configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-init-"));
  try {
    for (const selection of [[], ["--provider", "mock"]]) {
      await assert.rejects(
        run(process.execPath, [
          "--import",
          "tsx",
          "src/cli.ts",
          "init",
          "--config",
          join(directory, "config.json"),
          ...selection,
        ]),
        (error: unknown) => {
          assert.match(
            String((error as { stderr: string }).stderr),
            /PROVIDER_REQUIRED|MOCK_PROVIDER_REMOVED/,
          );
          return true;
        },
      );
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
