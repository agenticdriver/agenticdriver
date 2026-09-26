import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexMcpBridge } from "../src/providers/codex-mcp-bridge.js";
import { codex } from "../src/providers/local-cli.js";
import { HostProviderConfigSchema } from "../src/provider-config.js";
import type { DriverError } from "../src/errors.js";

const tool = {
  name: "read",
  description: "Read application data",
  inputSchema: { type: "object" },
};
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-bridge-test-"));
  let interrupts = 0;
  const errors: DriverError[] = [];
  const bridge = await codexMcpBridge({
    directory,
    tools: [tool],
    interrupt: () => {
      interrupts++;
    },
    fail: (error) => errors.push(error),
  });
  const manifest = JSON.parse(await readFile(bridge.config.args[1]!, "utf8"));
  return {
    bridge,
    directory,
    errors,
    manifest,
    get interrupts() {
      return interrupts;
    },
    started(id: string, args: Record<string, unknown> = { key: "selected" }) {
      bridge.started({
        id,
        server: bridge.name,
        tool: "read",
        arguments: args,
      });
    },
    send(body: unknown, token = manifest.token) {
      return fetch(manifest.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("native tools are opt-in and cannot be configured for other providers", () => {
  assert.equal(codex().info.capabilities.tools, false);
  for (const kind of ["claude-code", "gemini-cli", "mock"])
    assert.equal(
      HostProviderConfigSchema.safeParse({
        kind,
        id: "provider",
        applicationTools: "mcp",
      }).success,
      false,
    );
  assert.equal(
    HostProviderConfigSchema.safeParse({
      kind: "codex",
      id: "provider",
      applicationTools: "mcp",
    }).success,
    true,
  );
  assert.throws(() => codex({ applicationTools: "shell" as "mcp" }));
});

test("each native proposal needs its own helper confirmation before SDK execution", async () => {
  const s = await setup();
  try {
    assert.equal((await stat(s.bridge.config.args[1]!)).mode & 0o777, 0o600);
    assert.equal(
      JSON.stringify(s.bridge.config).includes(s.manifest.token),
      false,
    );
    s.started("a");
    s.started("b");
    assert.equal(
      (
        await s.send({
          requestId: 1,
          name: "read",
          arguments: { key: "selected" },
        })
      ).status,
      204,
    );
    assert.equal(s.interrupts, 0);
    assert.throws(() => s.bridge.finish(), { code: "CLI_POLICY_VIOLATION" });
    await s.send({
      requestId: 2,
      name: "read",
      arguments: { key: "selected" },
    });
    assert.equal(s.interrupts, 1);
    const calls = s.bridge.finish();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0]!.id, calls[1]!.id);
    assert.deepEqual(
      calls.map((c) => c.arguments),
      [{ key: "selected" }, { key: "selected" }],
    );
    // A late unconfirmed native proposal invalidates the entire batch.
    s.started("c");
    assert.throws(() => s.bridge.finish(), { code: "CLI_POLICY_VIOLATION" });
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test("reordered IPC is matched exactly, including duplicate counts and arguments", async () => {
  const s = await setup();
  try {
    await s.send({
      requestId: "a",
      name: "read",
      arguments: { key: "second" },
    });
    s.started("native-one", { key: "first" });
    assert.equal(s.interrupts, 0);
    s.started("native-two", { key: "second" });
    await s.send({ requestId: "b", name: "read", arguments: { key: "first" } });
    assert.equal(s.interrupts, 1);
    assert.deepEqual(
      s.bridge.finish().map((c) => c.arguments),
      [{ key: "first" }, { key: "second" }],
    );
  } finally {
    await s.close();
  }
});

test("unauthenticated traffic cannot interrupt the native process; malformed owned IPC fails closed", async () => {
  const s = await setup();
  try {
    assert.equal((await s.send({ private: "marker" }, "wrong")).status, 401);
    assert.equal(s.errors.length, 0);
    assert.equal(
      (
        await s.send({
          requestId: "a",
          name: "read",
          arguments: {},
          extra: "private-marker",
        })
      ).status,
      400,
    );
    assert.equal(s.errors[0]?.code, "CLI_POLICY_VIOLATION");
    assert.doesNotMatch(JSON.stringify(s.errors), /private-marker/);
    assert.equal(s.interrupts, 0);
  } finally {
    await s.close();
  }
});

test("unrecognized native server, reused IDs, premature completion and oversized batches are rejected", async () => {
  const s = await setup();
  try {
    assert.throws(
      () =>
        s.bridge.started({
          id: "x",
          server: "ambient",
          tool: "read",
          arguments: {},
        }),
      { code: "CLI_POLICY_VIOLATION" },
    );
    s.started("one");
    assert.throws(() => s.started("one"), { code: "CLI_POLICY_VIOLATION" });
    assert.throws(
      () => s.bridge.completed({ id: "one", server: s.bridge.name }),
      { code: "CLI_POLICY_VIOLATION" },
    );
    for (let i = 1; i < 32; i++) s.started(`id-${i}`);
    assert.throws(() => s.started("overflow"), {
      code: "CLI_POLICY_VIOLATION",
    });
    await s.send({ requestId: "same", name: "read", arguments: {} });
    assert.equal(
      (await s.send({ requestId: "same", name: "read", arguments: {} })).status,
      400,
    );
    assert.equal(s.errors.at(-1)?.code, "CLI_POLICY_VIOLATION");
  } finally {
    await s.close();
  }
});
