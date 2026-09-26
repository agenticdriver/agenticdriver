import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedHost } from "../src/management.js";
import { ManagementSnapshotSchema } from "../src/management-types.js";
import { providerDefinitions } from "../src/provider-definitions.js";

test("setup discovery does not read provider secrets, start native processes or infer account access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-definitions-"));
  try {
    const path = join(directory, "host.json"),
      binary = join(directory, "native");
    const marker = join(directory, "native-was-started");
    await writeFile(binary, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
      mode: 0o700,
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        usage: { hostId: "definitions-fixture" },
        listen: { port: 0 },
        providers: [
          { kind: "codex", id: "native", binary, applicationTools: "mcp" },
          { kind: "openai", id: "api", apiKeyRef: { env: "NEVER_RESOLVE" } },
        ],
        tokens: [],
      }),
    );
    let reads = 0;
    const host = await managedHost(path, {
      secrets: async () => {
        reads++;
        throw new Error("must not read");
      },
    });
    const state = ManagementSnapshotSchema.parse(host.management.snapshot());
    assert.equal(reads, 0);
    await assert.rejects(stat(marker), { code: "ENOENT" });
    assert.deepEqual(
      state.supportedKinds,
      state.providerDefinitions!.map((d) => d.kind),
    );
    assert.equal(state.providers[0]!.models, undefined);
    assert.equal(
      "applicationTools" in state.providers[0]! &&
        state.providers[0].applicationTools,
      "mcp",
    );
    assert.equal(state.executionProviders, undefined);
    for (const definition of state.providerDefinitions!) {
      assert.equal("models" in definition, false);
      assert.equal("authenticated" in definition, false);
      assert.equal("verified" in definition, false);
    }
    state.providerDefinitions![0]!.methods[0]!.label = "mutated by consumer";
    assert.notEqual(
      host.management.snapshot().providerDefinitions![0]!.methods[0]!.label,
      "mutated by consumer",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup wire accepts older hosts, exposes supported methods and preserves native tool settings", async () => {
  const fixture = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../protocol/fixtures/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
  const legacy = ManagementSnapshotSchema.parse(await fixture("management"));
  assert.equal(legacy.providerDefinitions, undefined);
  const modern = ManagementSnapshotSchema.parse(
    await fixture("management-catalog"),
  );
  assert.deepEqual(modern.providerDefinitions, providerDefinitions());
  const api = modern.providerDefinitions!.find((d) => d.kind === "openai")!;
  assert.deepEqual(
    api.methods.map((m) => m.interaction),
    ["api-key", "secret-reference"],
  );
  const native = modern.providerDefinitions!.find((d) => d.kind === "codex")!;
  assert.equal(native.methods[0]!.credentialOwner, "native-runtime");
  assert.equal(native.methods[0]!.interaction, "external");
  assert.deepEqual(modern.providers[0], {
    id: "native",
    kind: "codex",
    models: [],
    applicationTools: "mcp",
  });
  for (const providerDefinitions of [
    null,
    {},
    [{ ...api, methods: [] }],
    [{ ...api, docsUrl: "javascript:alert(1)" }],
    [{ ...api, methods: [{ ...api.methods[0], interaction: "" }] }],
  ]) {
    assert.equal(
      ManagementSnapshotSchema.safeParse({ ...modern, providerDefinitions })
        .success,
      false,
    );
  }
});
