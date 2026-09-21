import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticDriver } from "../src/driver.js";
import {
  openai,
  anthropic,
  gemini,
  xai,
  xaiResponses,
  codex,
} from "../src/providers/index.js";
import { normalizeCli, runProcess } from "../src/providers/local-cli.js";
import { UsageStatClient } from "../src/usagestat.js";
import type { ProviderAdapter, Tool } from "../src/types.js";

const tool: Tool = {
  name: "lookup",
  description: "Read a record",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: () => ({ found: true }),
};
function fixture(responses: unknown[]) {
  const calls: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      redirect: init?.redirect,
    });
    return new Response(JSON.stringify(responses.shift()), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetcher };
}
async function run(adapter: ProviderAdapter) {
  return new AgenticDriver({ providers: [adapter], tools: [tool] }).run({
    provider: adapter.info.id,
    model: "test-model",
    input: "Look up a record",
    tools: ["lookup"],
  });
}

test("native session continuation replays private API state without exporting it", async () => {
  const cases = [
    {
      factory: openai,
      response: {
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "r1",
            encrypted_content: "private-state-marker",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "visible" }],
          },
        ],
      },
    },
    {
      factory: xaiResponses,
      response: {
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "r1",
            encrypted_content: "private-state-marker",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "visible" }],
          },
        ],
      },
    },
    {
      factory: anthropic,
      response: {
        stop_reason: "end_turn",
        content: [
          {
            type: "thinking",
            thinking: "private-state-marker",
            signature: "signature",
          },
          { type: "text", text: "visible" },
        ],
      },
    },
    {
      factory: gemini,
      response: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [
                {
                  thought: true,
                  text: "private-state-marker",
                  thoughtSignature: "signature",
                },
                { text: "visible" },
              ],
            },
          },
        ],
      },
    },
  ];
  for (const { factory, response } of cases) {
    const f = fixture([response, response]);
    const provider = factory({ apiKey: "fixture", fetch: f.fetcher });
    const driver = new AgenticDriver({
      providers: [provider],
      usage: {
        hostId: "session-test",
        accounts: { [provider.info.id]: "test-account" },
      },
      sessions: { retentionMs: 60000 },
    });
    const created = driver.createSession({
      provider: provider.info.id,
      model: "test-model",
      mode: "native",
    });
    const request = {
      provider: provider.info.id,
      model: "test-model",
      input: "hello",
      session: { id: created.session.id, revision: 0 },
    };
    const first = await driver.run(request);
    assert.equal(first.text, "visible");
    const second = await driver.run({
      ...request,
      session: { ...request.session, revision: 1 },
    });
    assert.equal(second.text, "visible");
    assert.ok(
      JSON.stringify(f.calls[1]!.body).includes("private-state-marker"),
    );
    assert.equal(
      JSON.stringify({
        first,
        second,
        exported: driver.readSession({ id: created.session.id }),
      }).includes("private-state-marker"),
      false,
    );
    driver.deleteSession({ id: created.session.id });
  }
});

test("OpenAI retains native reasoning items and tool call IDs across stateless turns", async () => {
  const native = [
    { type: "reasoning", id: "r1", encrypted_content: "opaque" },
    {
      type: "function_call",
      call_id: "c1",
      name: "lookup",
      arguments: '{"id":"a"}',
    },
  ];
  const f = fixture([
    {
      status: "completed",
      output: native,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Found" }] },
      ],
      usage: { input_tokens: 15, output_tokens: 3 },
    },
  ]);
  const result = await run(openai({ apiKey: "test-secret", fetch: f.fetcher }));
  assert.equal(result.text, "Found");
  assert.deepEqual((f.calls[1]!.body.input as unknown[]).slice(1, 3), native);
  assert.equal(
    (f.calls[1]!.body.input as { call_id?: string }[]).at(-1)?.call_id,
    "c1",
  );
  assert.equal(f.calls[0]!.headers.get("Authorization"), "Bearer test-secret");
  assert.equal(f.calls[0]!.body.store, false);
  assert.equal(f.calls[0]!.redirect, "error");
});

test("Anthropic preserves tool-use blocks and includes cached input in usage totals", async () => {
  const native = [
    { type: "tool_use", id: "c1", name: "lookup", input: { id: "a" } },
  ];
  const f = fixture([
    {
      stop_reason: "tool_use",
      content: native,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 4,
      },
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Found" }],
      usage: {
        input_tokens: 8,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  ]);
  const result = await run(
    anthropic({ apiKey: "test-secret", fetch: f.fetcher }),
  );
  assert.equal(result.usage.inputTokens, 25);
  assert.equal(f.calls[0]!.headers.get("x-api-key"), "test-secret");
  assert.deepEqual(
    (f.calls[1]!.body.messages as { content: unknown }[])[1]?.content,
    native,
  );
});

test("Gemini retains function thought signatures and excludes thoughts from visible text", async () => {
  const native = [
    {
      functionCall: { id: "c1", name: "lookup", args: { id: "a" } },
      thoughtSignature: "signature",
    },
  ];
  const f = fixture([
    {
      candidates: [
        { finishReason: "STOP", content: { role: "model", parts: native } },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    },
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "private thought", thought: true },
              { text: "Found" },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 1,
      },
    },
  ]);
  const result = await run(gemini({ apiKey: "test-secret", fetch: f.fetcher }));
  assert.equal(result.text, "Found");
  assert.equal(result.usage.outputTokens, 10);
  assert.deepEqual(
    (f.calls[1]!.body.contents as { parts: unknown }[])[1]?.parts,
    native,
  );
  assert.equal(f.calls[0]!.url.includes("test-secret"), false);
  assert.equal(f.calls[0]!.headers.get("x-goog-api-key"), "test-secret");
});

test("Grok uses authenticated xAI chat completions with tool results", async () => {
  const f = fixture([
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: { name: "lookup", arguments: '{"id":"a"}' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Found" },
        },
      ],
    },
  ]);
  assert.equal(
    (await run(xai({ apiKey: "test-secret", fetch: f.fetcher }))).text,
    "Found",
  );
  assert.equal(f.calls[0]!.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(
    (f.calls[1]!.body.messages as { tool_call_id?: string }[]).at(-1)
      ?.tool_call_id,
    "c1",
  );
});

test("provider HTTP errors are classified and redact response bodies", async () => {
  const fetcher = (async () =>
    new Response("private-secret", { status: 429 })) as typeof fetch;
  await assert.rejects(
    run(openai({ apiKey: "test-secret", fetch: fetcher })),
    (e) =>
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      e.code === "RATE_LIMITED" &&
      "retryable" in e &&
      e.retryable === true &&
      !JSON.stringify(e).includes("private-secret"),
  );
});

test("CLI normalization requires success markers and rejects unexpected tools", () => {
  assert.deepEqual(
    normalizeCli(
      "codex",
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2}}',
    ).text,
    "done",
  );
  assert.throws(
    () =>
      normalizeCli(
        "codex",
        '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      ),
    { code: "INCOMPLETE_STREAM" },
  );
  assert.throws(
    () =>
      normalizeCli(
        "codex",
        '{"type":"item.started","item":{"type":"command_execution"}}',
      ),
    { code: "CLI_POLICY_VIOLATION" },
  );
  assert.equal(
    normalizeCli(
      "claude-code",
      '{"type":"result","is_error":false,"result":"done","usage":{"input_tokens":2,"cache_read_input_tokens":4,"cache_creation_input_tokens":0,"output_tokens":3}}',
    ).usage?.inputTokens,
    6,
  );
  assert.equal(
    normalizeCli(
      "gemini-cli",
      '{"response":"done","stats":{"models":{"m":{"tokens":{"prompt":2,"candidates":3,"thoughts":4}}}}}',
    ).usage?.outputTokens,
    7,
  );
});

test("CLI subprocess input cannot become a shell command and cancellation kills a stuck child", async () => {
  const value = "$(touch /should-never-exist); `echo nope`";
  assert.equal(
    await runProcess(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { env: {}, signal: AbortSignal.timeout(2000), input: value },
    ),
    value,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: {},
      signal: AbortSignal.timeout(30),
    }),
    { code: "TIMEOUT" },
  );
});

// This fixture is a POSIX executable; Windows native wrapper support is tracked in AD-012.
test(
  "Codex runs a restricted child with stdin context and no ambient provider keys",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-cli-fixture-"),
    );
    const binary = join(directory, "codex-fixture");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('--ignore-user-config --ephemeral --sandbox --json');
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const text = JSON.stringify({ input, restricted: args.includes('--ignore-user-config') && args.includes('--ephemeral') && args[args.indexOf('--sandbox') + 1] === 'read-only',
      account: process.env.CODEX_HOME, privateCwd: process.cwd() !== process.env.CODEX_HOME,
      leakedKey: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'AGENTICDRIVER_TOKEN'].some(key => key in process.env) });
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }));
  });
}
`,
      { mode: 0o700 },
    );
    try {
      const provider = codex({ binary, accountDirectory: directory });
      const input = "Literal $(echo should-not-execute) and 🌍";
      const result = await new AgenticDriver({ providers: [provider] }).run({
        provider: "codex",
        model: "fixture",
        input,
      });
      const output = JSON.parse(result.text);
      assert.ok(output.input.includes(input));
      assert.equal(output.restricted, true);
      assert.equal(output.privateCwd, true);
      assert.equal(output.account, directory);
      assert.equal(output.leakedKey, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Usagestat reads the existing provider, usage, and quota contracts", async () => {
  const client = new UsageStatClient({
    fetch: (async (url) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === "/v1/providers"
          ? [
              {
                id: "codex",
                name: "Codex",
                icon: {
                  kind: "svg",
                  path: "/icons/codex.svg",
                  colorPath: "/icons/codex-color.svg",
                },
              },
            ]
          : path === "/v1/usage"
            ? [
                {
                  providerId: "codex",
                  displayName: "Codex",
                  fetchedAt: "2026-09-20T00:00:00Z",
                  metrics: [],
                },
              ]
            : {
                schema: "crossusage.limits.v1",
                providers: {
                  codex: {
                    displayName: "Codex",
                    fetchedAt: "2026-09-20T00:00:00Z",
                    resources: {
                      weekly: {
                        used: 20,
                        limit: 100,
                        remaining: 80,
                        unit: "percent",
                        label: "Weekly",
                      },
                    },
                  },
                },
                errors: [],
              };
      return new Response(JSON.stringify(body));
    }) as typeof fetch,
  });
  assert.equal(
    (await client.providers())[0]?.icon?.colorPath,
    "/icons/codex-color.svg",
  );
  assert.equal((await client.usage())[0]?.providerId, "codex");
  assert.equal(
    (await client.limits()).providers.codex?.resources.weekly?.remaining,
    80,
  );
});
