import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import { openai, anthropic, gemini, xai } from "../src/providers/index.js";
import { createCliStream } from "../src/providers/local-cli.js";
import type { ProviderContext, RunEvent, Tool } from "../src/types.js";

const encoder = new TextEncoder();
function frame(value: unknown) {
  return encoder.encode(
    `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`,
  );
}
function fixture(turns: unknown[][]) {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const events = turns.shift();
    assert.ok(events, "Unexpected provider step");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(frame(event));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { bodies, fetcher };
}
const request = { model: "test-model", input: "Find a record" };
const lookup: Tool = {
  name: "lookup",
  description: "Read a record",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  execute: () => ({ found: true }),
};

test("OpenAI text reaches the consumer before the provider finishes, without duplicate final text", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            frame({ type: "response.output_text.delta", delta: "Hello" }),
          );
          await gate;
          controller.enqueue(
            frame({ type: "response.output_text.delta", delta: " world" }),
          );
          controller.enqueue(
            frame({
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Hello world" }],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2 },
              },
            }),
          );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const driver = new AgenticDriver({
    providers: [openai({ apiKey: "fixture", fetch: fetcher })],
  });
  const events: RunEvent[] = [];
  for await (const event of driver.stream({ ...request, provider: "openai" })) {
    events.push(event);
    if (event.type === "text.delta" && event.text === "Hello") finish();
  }
  assert.deepEqual(
    events.filter((e) => e.type === "text.delta").map((e) => e.text),
    ["Hello", " world"],
  );
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("Anthropic streaming preserves thinking signatures, fragmented tool input, and final usage", async () => {
  const f = fixture([
    [
      {
        type: "message_start",
        message: {
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "c1",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"id":' },
      },
      { type: "ping" },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"a"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ],
    [
      {
        type: "message_start",
        message: {
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 6,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Found" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ],
  ]);
  const driver = new AgenticDriver({
    providers: [anthropic({ apiKey: "fixture", fetch: f.fetcher })],
    tools: [lookup],
  });
  const result = await driver.run({
    ...request,
    provider: "anthropic",
    tools: ["lookup"],
  });
  assert.equal(result.text, "Found");
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 6);
  const messages = f.bodies[1]!.messages as { content: unknown[] }[];
  assert.deepEqual(messages[1]!.content, [
    { type: "thinking", thinking: "private reasoning", signature: "signed" },
    { type: "tool_use", id: "c1", name: "lookup", input: { id: "a" } },
  ]);
});

test("Gemini streaming carries signed function calls into the next turn", async () => {
  const signed = {
    functionCall: { id: "c1", name: "lookup", args: { id: "a" } },
    thoughtSignature: "opaque",
  };
  const f = fixture([
    [
      {
        candidates: [{ content: { parts: [signed] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 1,
          thoughtsTokenCount: 0,
        },
      },
    ],
    [
      {
        candidates: [
          { content: { parts: [{ thought: true, text: "private" }] } },
        ],
      },
      {
        candidates: [
          { content: { parts: [{ text: "Found" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 3,
        },
      },
    ],
  ]);
  const driver = new AgenticDriver({
    providers: [gemini({ apiKey: "fixture", fetch: f.fetcher })],
    tools: [lookup],
  });
  const result = await driver.run({
    ...request,
    provider: "gemini",
    tools: ["lookup"],
  });
  assert.equal(result.text, "Found");
  assert.equal(result.usage.outputTokens, 6);
  assert.deepEqual(
    (f.bodies[1]!.contents as { parts: unknown[] }[])[1]!.parts,
    [signed],
  );
});

test("Grok streaming assembles tool argument fragments and the trailing usage chunk", async () => {
  const f = fixture([
    [
      { choices: [{ delta: { reasoning_content: "private" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"id":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"a"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
      "[DONE]",
    ],
    [
      { choices: [{ delta: { content: "Found" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
      "[DONE]",
    ],
  ]);
  const driver = new AgenticDriver({
    providers: [xai({ apiKey: "fixture", fetch: f.fetcher })],
    tools: [lookup],
  });
  const result = await driver.run({
    ...request,
    provider: "xai",
    tools: ["lookup"],
  });
  assert.equal(result.text, "Found");
  assert.equal(result.usage.outputTokens, 5);
  const messages = f.bodies[1]!.messages as { tool_calls?: unknown[] }[];
  assert.deepEqual(messages[1]!.tool_calls, [
    {
      id: "c1",
      type: "function",
      function: { name: "lookup", arguments: '{"id":"a"}' },
    },
  ]);
});

test("provider pings and SSE keepalives cannot prevent an inactivity timeout", async () => {
  let stopped = false;
  const fetcher = (async (_url, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setInterval(() => {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            controller.enqueue(frame({ type: "ping" }));
          }, 5);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearInterval(timer);
              stopped = true;
              controller.close();
            },
            { once: true },
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;
  const driver = new AgenticDriver({
    providers: [anthropic({ apiKey: "fixture", fetch: fetcher })],
  });
  await assert.rejects(
    driver.run({ ...request, provider: "anthropic", idleTimeoutMs: 40 }),
    { code: "IDLE_TIMEOUT" },
  );
  assert.equal(stopped, true);
});

test("a partial provider stream never becomes a successful result", async () => {
  for (const [factory, frames] of [
    [openai, [{ type: "response.output_text.delta", delta: "partial" }]],
    [
      anthropic,
      [{ type: "message_start", message: { content: [], stop_reason: null } }],
    ],
    [gemini, [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]],
    [
      xai,
      [{ choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }],
    ],
  ] as const) {
    const f = fixture([[...frames]]),
      provider = factory({ apiKey: "fixture", fetch: f.fetcher });
    await assert.rejects(
      new AgenticDriver({ providers: [provider] }).run({
        ...request,
        provider: provider.info.id,
      }),
      { code: "INCOMPLETE_STREAM" },
    );
  }
});

test("CLI JSONL forwards partial text, handles reasoning, and requires terminal results", () => {
  const chunks: string[] = [];
  let progress = 0;
  const context: ProviderContext = {
    runId: "run",
    subject: "local",
    signal: new AbortController().signal,
    emitText: (text) => {
      chunks.push(text);
    },
    reportProgress: () => {
      progress++;
    },
  };
  const claude = createCliStream("claude-code", context);
  for (const delta of [
    { type: "thinking_delta", thinking: "private" },
    { type: "text_delta", text: "Hello" },
  ])
    claude.accept(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta },
      }),
    );
  claude.accept(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    }),
  );
  claude.accept(
    JSON.stringify({ type: "result", is_error: false, result: "Hello" }),
  );
  assert.equal(claude.finish("").text, "Hello");
  assert.deepEqual(chunks, ["Hello"]);
  assert.equal(progress, 1);
  const gemini = createCliStream("gemini-cli", context);
  gemini.accept(
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Found",
      delta: true,
    }),
  );
  gemini.accept(
    JSON.stringify({
      type: "result",
      status: "success",
      stats: { input_tokens: 5, output_tokens: 2, cached: 1 },
    }),
  );
  assert.equal(gemini.finish("").usage?.cachedInputTokens, 1);
  assert.throws(() => createCliStream("gemini-cli", context).finish(""), {
    code: "INCOMPLETE_STREAM",
  });
  assert.throws(() => gemini.accept(JSON.stringify({ type: "tool_use" })), {
    code: "CLI_POLICY_VIOLATION",
  });
});
