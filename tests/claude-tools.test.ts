import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeToolHistory,
  createCliStream,
} from "../src/providers/local-cli.js";
import { nativeMcpBridge } from "../src/providers/native-mcp-bridge.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const context = {
  runId: "protocol-test",
  subject: "protocol-test",
  signal: new AbortController().signal,
  emitText() {},
  reportProgress() {},
};

test("Claude portable tool history retains arguments, results and IDs without private native state", () => {
  const request = {
    model: "selected",
    tools: [],
    maxOutputTokens: 128,
    messages: [
      {
        role: "assistant" as const,
        content: "Checking notes",
        native: { private: "not application history" },
        toolCalls: [
          {
            id: "call-1",
            name: "read_release",
            arguments: { revision: "rc3" },
          },
        ],
      },
      {
        role: "tool" as const,
        name: "read_release",
        callId: "call-1",
        content: "Release remains a candidate.",
      },
    ],
  };
  const prompt = claudeToolHistory(request);
  assert.ok(!prompt.includes("not application history"));
  const history = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
  assert.deepEqual(history[0].toolCalls, request.messages[0]!.toolCalls);
  assert.deepEqual(history[1], request.messages[1]);
});

test("Claude tool proposals need matched owned MCP confirmation and reject native tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tools-test-"));
  let interrupted = false;
  const bridge = await nativeMcpBridge({
    directory,
    tools: [
      {
        name: "read_release",
        description: "Read selected release notes",
        inputSchema: { type: "object" },
      },
    ],
    interrupt() {
      interrupted = true;
    },
    fail() {},
  });
  try {
    const stream = createCliStream("claude-code", context, bridge);
    stream.accept(
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: [`mcp__${bridge.name}__read_release`],
        mcp_servers: [{ name: bridge.name, status: "connected" }],
      }),
    );
    assert.throws(
      () =>
        stream.accept(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "bad",
                  name: "Bash",
                  input: { command: "ls" },
                },
              ],
            },
          }),
        ),
      { code: "CLI_POLICY_VIOLATION" },
    );
    stream.accept(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "native-call",
              name: `mcp__${bridge.name}__read_release`,
              input: { revision: "rc3" },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    );
    assert.equal(interrupted, false);
    assert.throws(() => bridge.finish(), { code: "CLI_POLICY_VIOLATION" });
    const manifest = JSON.parse(await readFile(bridge.config.args[1]!, "utf8"));
    await fetch(manifest.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${manifest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: 1,
        name: "read_release",
        arguments: { revision: "rc3" },
      }),
    });
    assert.equal(interrupted, true);
    const turn = stream.proposed(bridge.finish());
    assert.deepEqual(
      turn.toolCalls?.map((c) => ({ name: c.name, args: c.arguments })),
      [{ name: "read_release", args: { revision: "rc3" } }],
    );
    assert.deepEqual(turn.usage, {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 0,
    });
    await fetch(manifest.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${manifest.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.throws(() => bridge.finish(), { code: "CLI_POLICY_VIOLATION" });
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude refuses missing or widened native initialization inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tools-inventory-"));
  const bridge = await nativeMcpBridge({
    directory,
    tools: [
      {
        name: "selected",
        description: "Selected application operation",
        inputSchema: { type: "object" },
      },
    ],
    interrupt() {},
    fail() {},
  });
  try {
    const expected = `mcp__${bridge.name}__selected`;
    for (const tools of [[], [expected, "Bash"], [expected, expected]]) {
      const stream = createCliStream("claude-code", context, bridge);
      assert.throws(
        () =>
          stream.accept(
            JSON.stringify({
              type: "system",
              subtype: "init",
              tools,
              mcp_servers: [{ name: bridge.name, status: "connected" }],
            }),
          ),
        { code: "CLI_POLICY_VIOLATION" },
      );
    }
    const missing = createCliStream("claude-code", context, bridge);
    assert.throws(
      () =>
        missing.accept(
          JSON.stringify({ type: "assistant", message: { content: [] } }),
        ),
      { code: "CLI_POLICY_VIOLATION" },
    );
    const permission = createCliStream("claude-code", context, bridge);
    assert.throws(
      () =>
        permission.accept(
          JSON.stringify({
            type: "control_request",
            request: { subtype: "can_use_tool", tool_name: "Bash" },
          }),
        ),
      { code: "CLI_POLICY_VIOLATION" },
    );
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a parser failure after a requested proposal interrupt remains the actual process failure", async () => {
  const { runProcess } = await import("../src/providers/cli-process.js");
  const { DriverError } = await import("../src/errors.js");
  const interrupt = new AbortController();
  const expected = new DriverError(
    "NATIVE_TOOL_PROPOSED",
    "Proposal confirmed",
  );
  const policy = new DriverError(
    "CLI_POLICY_VIOLATION",
    "Unexpected native operation",
  );
  // A generic process writes two records atomically. It is not a model/CLI substitute.
  const operation = runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('confirmed\\ninvalid\\n');setInterval(()=>{},1000)",
    ],
    {
      env: {},
      signal: interrupt.signal,
      onLine(line) {
        if (line === "confirmed") interrupt.abort(expected);
        else throw policy;
      },
    },
  );
  await assert.rejects(
    operation,
    (error) => error === policy && error !== interrupt.signal.reason,
  );
});
