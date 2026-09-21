import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgenticDriver } from "../src/driver.js";
import { configuredDriver, readHostConfig } from "../src/host.js";
import { xai, xaiResponses } from "../src/providers/index.js";
import type { RunEvent, Tool, UsageRecord } from "../src/types.js";
import { CliProcess } from "./cli-helpers.js";

const message = (text: string) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});
const terminal = (text = "Found") => ({
  status: "completed",
  output: [message(text)],
});
const frame = (event: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const request = {
  provider: "work",
  model: "fixture-model",
  input: "Read the selected record",
};

test("xAI Responses preserves explicit identity, approved tool results, native state and measured usage", async () => {
  const native = [
    {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "opaque-private-state",
    },
    {
      type: "function_call",
      id: "item-1",
      call_id: "call-1",
      name: "lookup",
      arguments: '{"id":"selected"}',
    },
  ];
  const calls: { url: string; body: Record<string, any>; headers: Headers }[] =
    [];
  const records: UsageRecord[] = [];
  const replies = [
    {
      status: "completed",
      output: native,
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
    {
      ...terminal(),
      usage: {
        input_tokens: 32,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    },
  ];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    assert.ok(replies.length, "Unexpected extra provider request");
    return Response.json(replies.shift());
  };
  let effects = 0,
    approvals = 0;
  const tool: Tool = {
    name: "lookup",
    description: "Read the authorized record",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: { id: { const: "selected" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute(input, context) {
      assert.equal(input.id, "selected");
      assert.equal(context.subject, "alice");
      effects++;
      return { found: true };
    },
  };
  const provider = xaiResponses({
    id: "work",
    name: "Selected xAI account",
    apiKey: () => "fixture-key",
    models: [request.model],
    fetch: fetcher,
  });
  const driver = new AgenticDriver({
    providers: [provider],
    tools: [tool],
    approve: () => {
      approvals++;
      return true;
    },
    usage: { hostId: "fixture-host", accounts: { work: "selected-account" } },
    onUsage: (record) => {
      records.push(record);
    },
  });
  const result = await driver.run(
    {
      ...request,
      instructions: "Use only the selected record",
      tools: ["lookup"],
      maxOutputTokens: 128,
    },
    { subject: "alice" },
  );
  assert.equal(result.text, "Found");
  assert.equal(effects, 1);
  assert.equal(approvals, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://api.x.ai/v1/responses");
    assert.equal(call.headers.get("Authorization"), "Bearer fixture-key");
    assert.equal(call.body.model, request.model);
    assert.equal(call.body.instructions, "Use only the selected record");
    assert.equal(call.body.max_output_tokens, 128);
    assert.equal(call.body.store, false);
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.include, ["reasoning.encrypted_content"]);
    assert.equal(call.body.previous_response_id, undefined);
    assert.equal(call.body.tools.length, 1);
    assert.equal(call.body.tools[0].type, "function");
    assert.equal(call.body.tools[0].name, "lookup");
    assert.equal(call.body.tools[0].strict, undefined);
  }
  assert.deepEqual(calls[1]!.body.input.slice(1, 3), native);
  assert.deepEqual(calls[1]!.body.input.at(-1), {
    type: "function_call_output",
    call_id: "call-1",
    output: '{"found":true}',
  });
  assert.deepEqual(result.usage, {
    inputTokens: 52,
    outputTokens: 12,
    cachedInputTokens: 12,
    reasoningTokens: 5,
  });
  assert.equal(records[0]?.provider, "work");
  assert.equal(records[0]?.accountId, "selected-account");
  assert.equal(records[0]?.vendor, "xai");
  assert.equal(records[0]?.source, "provider-response");
  assert.equal(
    JSON.stringify({ result, records }).includes("opaque-private-state"),
    false,
  );
  assert.equal(provider.info.usageStatId, "xai");
  assert.equal(provider.info.capabilities.nativeContinuation, true);
  assert.equal(
    xai({ apiKey: "fixture" }).info.capabilities.nativeContinuation,
    false,
  );
  assert.throws(
    () =>
      xaiResponses({
        apiKey: "fixture",
        inputMediaTypes: { demo: ["application/pdf"] },
      }),
    { code: "INVALID_CONTEXT_POLICY" },
  );
});

test(
  "xAI Responses delivers text before completion and never exposes reasoning as visible text",
  { timeout: 3000 },
  async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              frame({
                type: "response.reasoning_summary_text.delta",
                delta: "private-reasoning",
              }),
            );
            controller.enqueue(
              frame({ type: "response.output_text.delta", delta: "First" }),
            );
            await gate;
            controller.enqueue(
              frame({ type: "response.output_text.delta", delta: " second" }),
            );
            controller.enqueue(
              frame({
                type: "response.completed",
                response: terminal("First second"),
              }),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const driver = new AgenticDriver({
      providers: [
        xaiResponses({ id: "work", apiKey: "fixture", fetch: fetcher }),
      ],
    });
    const events: RunEvent[] = [];
    try {
      for await (const event of driver.stream(request)) {
        events.push(event);
        if (event.type === "text.delta" && event.text === "First") finish();
      }
    } finally {
      finish();
    }
    assert.deepEqual(
      events.filter((e) => e.type === "text.delta").map((e) => e.text),
      ["First", " second"],
    );
    assert.equal(events.at(-1)?.type, "run.completed");
    assert.equal(JSON.stringify(events).includes("private-reasoning"), false);
  },
);

test("xAI Responses errors and unfinished streams fail without fallback or provider body disclosure", async () => {
  const cases: [() => Response, string][] = [
    [
      () => new Response("private-provider-detail", { status: 401 }),
      "PROVIDER_AUTH",
    ],
    [
      () => new Response("private-provider-detail", { status: 429 }),
      "RATE_LIMITED",
    ],
    [
      () => new Response("private-provider-detail", { status: 503 }),
      "PROVIDER_ERROR",
    ],
    [
      () => Response.json({ status: "in_progress", output: [] }),
      "PROVIDER_FAILED",
    ],
    [
      () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "function_call",
              call_id: "c",
              name: "lookup",
              arguments: "{}",
            },
          ],
        }),
      "TRUNCATED_TOOL_CALL",
    ],
    [
      () =>
        Response.json({
          ...terminal(),
          usage: { input_tokens: -1, output_tokens: 1 },
        }),
      "INVALID_PROVIDER_RESPONSE",
    ],
    [
      () =>
        new Response(
          frame({
            type: "response.failed",
            error: { message: "private-provider-detail" },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      "PROVIDER_FAILED",
    ],
    [
      () =>
        new Response(
          frame({ type: "response.output_text.delta", delta: "partial" }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      "INCOMPLETE_STREAM",
    ],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    const driver = new AgenticDriver({
      providers: [
        xaiResponses({
          id: "work",
          apiKey: "fixture",
          fetch: async () => {
            calls++;
            return response();
          },
        }),
      ],
    });
    await assert.rejects(
      driver.run(request),
      (error: any) =>
        error.code === code &&
        !JSON.stringify(error).includes("private-provider-detail"),
    );
    assert.equal(calls, 1);
  }
});

test(
  "xAI Responses caller cancellation aborts its sole provider request",
  { timeout: 3000 },
  async () => {
    const abort = new AbortController();
    let aborted = false,
      requests = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              frame({ type: "response.output_text.delta", delta: "partial" }),
            );
            init!.signal!.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(init!.signal!.reason);
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const driver = new AgenticDriver({
      providers: [
        xaiResponses({ id: "work", apiKey: "fixture", fetch: fetcher }),
      ],
    });
    const events: RunEvent[] = [];
    for await (const event of driver.stream(request, {
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === "text.delta") abort.abort();
    }
    assert.equal(aborted, true);
    assert.equal(requests, 1);
    assert.equal(events.at(-1)?.type, "run.cancelled");
  },
);

test("CLI initializes xAI Responses with the selected model and account; configured host uses the new route", async () => {
  const work = await mkdtemp(join(tmpdir(), "agenticdriver-xai-cli-"));
  const path = join(work, "config.json");
  let requests = 0;
  const api = createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.setHeader("Content-Type", "application/json");
    req.resume();
    req.on("end", () => res.end(JSON.stringify(terminal())));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await new CliProcess(
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      ],
      [
        "init",
        "--config",
        path,
        "--provider",
        "xai-responses",
        "--provider-id",
        "work",
        "--account-id",
        "selected-account",
        "--model",
        request.model,
        "--base-url",
        `http://127.0.0.1:${address.port}/v1/`,
      ],
    ).finished;
    assert.equal(result.code, 0, result.stderr);
    const config = await readHostConfig(path);
    const selected = config.providers[0]!;
    assert.equal(selected.kind, "xai-responses");
    assert.equal(selected.accountId, "selected-account");
    assert.deepEqual(selected.models, [request.model]);
    assert.ok("apiKeyRef" in selected);
    assert.deepEqual(selected.apiKeyRef, { env: "XAI_API_KEY" });
    assert.equal(config.limits?.idleTimeoutMs, undefined);
    const driver = configuredDriver(config, path, {
      secrets: async () => "fixture-key",
    });
    assert.equal((await driver.run(request)).text, "Found");
    assert.equal(requests, 1);
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(work, { recursive: true, force: true });
  }
});
