import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticClient } from "../src/client.js";
import { AgenticDriver } from "../src/driver.js";
import { configuredServer, readHostConfig } from "../src/host.js";
import { managedHost } from "../src/management.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import type { UsageRecord } from "../src/types.js";

const admin = "management-test-credential-at-least-32-characters";
const app = "application-test-credential-at-least-32-characters";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "driver-management-"));
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      usage: { hostId: "fixture-host" },
      listen: { port: 0 },
      providers: [{ kind: "mock", id: "fixture", accountId: "one" }],
      tokens: [
        {
          id: "operator",
          subject: "operator",
          tokenRef: { env: "ADMIN" },
          providers: [],
          manageProviders: true,
        },
        {
          id: "app",
          subject: "app",
          tokenRef: { env: "APP" },
          providers: ["fixture"],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const host = await managedHost(path);
  const server = await serve(host.driver, {
    ...(await configuredServer(host.config(), path, async (ref) =>
      "env" in ref && ref.env === "ADMIN" ? admin : app,
    )),
    management: host.management,
  });
  return {
    host,
    path,
    directory,
    operator: new AgenticClient({ url: server.url, token: admin }),
    client: new AgenticClient({ url: server.url, token: app }),
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("management requires its own grant and revision, persists overrides, and keeps scoped run access", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client.management(), { code: "FORBIDDEN" });
    const initial = await f.operator.management();
    await assert.rejects(
      f.client.configureProvider({
        revision: initial.revision,
        provider: initial.providers[0]!,
      }),
      { code: "FORBIDDEN" },
    );
    assert.equal((await f.operator.providers()).length, 1);
    await assert.rejects(
      f.operator.run({
        provider: "fixture",
        model: "demo",
        input: "Synthetic",
      }),
      { code: "FORBIDDEN" },
    );
    const next = await f.operator.configureProvider({
      revision: initial.revision,
      provider: {
        ...initial.providers[0]!,
        name: "Desk account",
        enabled: false,
      },
    });
    assert.notEqual(next.revision, initial.revision);
    await assert.rejects(
      f.client.run({ provider: "fixture", model: "demo", input: "Synthetic" }),
      { code: "UNSUPPORTED_MODEL" },
    );
    await assert.rejects(
      f.operator.configureProvider({
        revision: initial.revision,
        provider: initial.providers[0]!,
      }),
      { code: "CONFIG_CONFLICT" },
    );
    const restarted = await managedHost(f.path);
    assert.equal(restarted.management.snapshot().revision, next.revision);
    assert.equal(restarted.config().providers[0]!.enabled, false);
    const enabled = await f.operator.configureProvider({
      revision: next.revision,
      provider: { ...next.providers[0]!, enabled: true },
    });
    assert.equal(enabled.providers[0]!.models, undefined);
    assert.equal(
      (
        await f.client.run({
          provider: "fixture",
          model: "another-explicit-model",
          input: "Synthetic",
        })
      ).text,
      "AgenticDriver is connected.",
    );
    const added = await f.operator.configureProvider({
      revision: enabled.revision,
      provider: { kind: "mock", id: "second", accountId: "two" },
    });
    assert.equal(added.providers.length, 2);
    assert.equal((await f.client.providers()).length, 1);
    await assert.rejects(
      f.client.run({ provider: "second", model: "demo", input: "Synthetic" }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      f.operator.configureProvider({
        revision: added.revision,
        provider: { ...added.providers[0]!, accountId: "different" },
      }),
      { code: "PROVIDER_IDENTITY_CHANGED" },
    );
  } finally {
    await f.close();
  }
});

test("management writes API keys once to private references and never returns credential values", async () => {
  const f = await fixture();
  try {
    const initial = await f.operator.management();
    const secret = "fixture-key-must-not-appear-in-settings";
    const result = await f.operator.configureProvider({
      revision: initial.revision,
      provider: {
        kind: "openai",
        id: "api",
        accountId: "api-account",
        apiKeyRef: { env: "UNSET_FIXTURE_KEY" },
      },
      apiKey: secret,
    });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!(await readFile(f.path, "utf8")).includes(secret));
    const stored = (await readHostConfig(f.path)).providers[1]!;
    assert.ok("apiKeyRef" in stored && "file" in stored.apiKeyRef);
    assert.equal(
      (await readFile(stored.apiKeyRef.file, "utf8")).trim(),
      secret,
    );
    if (process.platform !== "win32")
      assert.equal((await stat(stored.apiKeyRef.file)).mode & 0o777, 0o600);
    await writeFile(
      f.path,
      JSON.stringify({ ...f.host.config(), usageLog: "outside-edit.jsonl" }),
    );
    await assert.rejects(
      f.operator.configureProvider({
        revision: result.revision,
        provider: result.providers[0]!,
      }),
      { code: "CONFIG_CONFLICT" },
    );
  } finally {
    await f.close();
  }
});

test("provider updates preserve an active run's adapter, account and usage snapshot; new runs use new settings", async () => {
  let finish!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const records: UsageRecord[] = [];
  const old = {
    ...mockProvider(),
    info: { ...mockProvider().info, id: "connection" },
  };
  const driver = new AgenticDriver({
    providers: [
      {
        ...old,
        complete: async () => {
          started();
          await gate;
          return { text: "old account", usage: { inputTokens: 1 } };
        },
      },
    ],
    usage: { hostId: "host", accounts: { connection: "old-account" } },
    onUsage: (record) => {
      records.push(record);
    },
  });
  const pending = driver.run({
    provider: "connection",
    model: "demo",
    input: "Synthetic",
  });
  await ready;
  driver.configureProviders([{ ...old, info: { ...old.info, models: [] } }], {
    connection: "new-account",
  });
  await assert.rejects(
    driver.run({ provider: "connection", model: "demo", input: "Synthetic" }),
    { code: "UNSUPPORTED_MODEL" },
  );
  finish();
  assert.equal((await pending).text, "old account");
  assert.equal(records[0]!.accountId, "old-account");
});

test("catalog refreshes from replaced adapters cannot overwrite the new instance metadata", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const base = {
    ...mockProvider(),
    info: { ...mockProvider().info, id: "connection" },
  };
  const driver = new AgenticDriver({
    providers: [
      {
        ...base,
        inspect: async () => {
          await gate;
          return { code: "CATALOG_AVAILABLE", models: ["old"] };
        },
      },
    ],
  });
  const before = driver.discoverProviders();
  driver.configureProviders([
    {
      ...base,
      inspect: async () => ({ code: "CATALOG_AVAILABLE", models: ["new"] }),
    },
  ]);
  assert.deepEqual(
    (await driver.discoverProviders())[0]!.modelCatalog!.models,
    ["new"],
  );
  finish();
  await before;
  assert.deepEqual(
    (await driver.discoverProviders())[0]!.modelCatalog!.models,
    ["new"],
  );
});
