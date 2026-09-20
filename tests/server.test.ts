import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient, readSse } from "../src/client.js";
import { serve } from "../src/server.js";
import { mockProvider } from "../src/providers/mock.js";
import type { UsageRecord } from "../src/types.js";

const token = "test-token-with-at-least-32-characters";
const request = { provider: "mock", model: "demo", input: "Hello 🌍" };

test("JSON and SSE round trips share the normalized result", async () => {
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => ({
        text: "Hello 🌍",
        usage: { inputTokens: 4, outputTokens: 2 },
      })),
    ],
  });
  const server = await serve(driver, {
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
    port: 0,
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.equal((await client.providers())[0]?.id, "mock");
    assert.equal((await client.run(request)).text, "Hello 🌍");
    const jsonResponse = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
    });
    assert.equal(
      ((await jsonResponse.json()) as { text: string }).text,
      "Hello 🌍",
    );
    const events = [];
    for await (const event of client.stream(request)) events.push(event);
    assert.equal(events.at(-1)?.type, "run.completed");
    assert.equal(events.find((e) => e.type === "text.delta")?.text, "Hello 🌍");
  } finally {
    await server.close();
  }
});

test("remote runs outlive an idle interval while active and report IDLE_TIMEOUT when stalled", async () => {
  const driver = new AgenticDriver({
    providers: [
      mockProvider(async (input, context) => {
        if (input.messages.at(-1)?.content === "stall")
          return new Promise(() => {});
        for (let i = 0; i < 6; i++) {
          await delay(20);
          context.emitText(".");
        }
        return { text: "......" };
      }),
    ],
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.equal(
      (await client.run({ ...request, idleTimeoutMs: 80 })).text,
      "......",
    );
    await assert.rejects(
      client.run({ ...request, input: "stall", idleTimeoutMs: 40 }),
      { code: "IDLE_TIMEOUT" },
    );
  } finally {
    await server.close();
  }
});

test("requires tokens, scopes provider discovery, rejects hostile origins and request fields", async () => {
  const driver = new AgenticDriver({ providers: [mockProvider()] });
  const server = await serve(driver, {
    tokens: [{ token, subject: "restricted", providers: [] }],
    port: 0,
  });
  try {
    assert.equal((await fetch(server.url + "/v1/providers")).status, 401);
    assert.deepEqual(
      await new AgenticClient({ url: server.url, token }).providers(),
      [],
    );
    await assert.rejects(
      new AgenticClient({ url: server.url, token }).run(request),
      { code: "FORBIDDEN" },
    );
    assert.equal(
      (
        await fetch(server.url + "/v1/providers", {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://hostile.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(server.url + "/v1/runs", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...request, apiKey: "never-allowed" }),
        })
      ).status,
      400,
    );
  } finally {
    await server.close();
  }
});

test("rejects insecure transport and secrets in URLs", async () => {
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?token=abc",
  ])
    assert.throws(() => new AgenticClient({ url, token }), {
      code: "INSECURE_TRANSPORT",
    });
  await assert.rejects(
    serve(new AgenticDriver({ providers: [] }), {
      host: "0.0.0.0",
      tokens: [{ token, subject: "s", providers: [] }],
    }),
    { code: "TLS_REQUIRED" },
  );
});

test("HTTP cancellation aborts the provider and meters the authenticated subject", async () => {
  let aborted = false;
  const records: UsageRecord[] = [];
  const adapter = mockProvider();
  adapter.complete = async (_request, context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(context.signal.reason);
        },
        { once: true },
      );
    });
  const server = await serve(
    new AgenticDriver({
      providers: [adapter],
      onUsage: (r) => {
        records.push(r);
      },
    }),
    { tokens: [{ token, subject: "real-user", providers: ["mock"] }], port: 0 },
  );
  try {
    const client = new AgenticClient({ url: server.url, token });
    for await (const event of client.stream(request)) {
      if (event.type === "step.started") {
        await delay(20);
        break;
      }
    }
    for (let i = 0; i < 50 && !records.length; i++) await delay(10);
    assert.equal(aborted, true);
    assert.equal(records[0]?.subject, "real-user");
    assert.equal(records[0]?.status, "cancelled");
  } finally {
    await server.close();
  }
});

test("enforces per-subject concurrency limits", async () => {
  const adapter = mockProvider(() => new Promise(() => {}));
  const server = await serve(new AgenticDriver({ providers: [adapter] }), {
    maxConcurrentRunsPerSubject: 1,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
    port: 0,
  });
  const cancel = new AbortController();
  try {
    const first = await fetch(server.url + "/v1/runs", {
      method: "POST",
      signal: cancel.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
    });
    assert.equal(first.status, 200);
    await assert.rejects(
      new AgenticClient({ url: server.url, token }).run(request),
      { code: "BUSY" },
    );
    cancel.abort();
    await first.body?.cancel().catch(() => {});
  } finally {
    cancel.abort();
    await server.close();
  }
});

test("SSE parser handles byte splits, UTF-8, CRLF, and multiline data", async () => {
  const bytes = new TextEncoder().encode(
    ': comment\r\ndata: {"text":\r\ndata: "🌍"}\r\n\r\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const values = [];
  for await (const value of readSse(stream)) values.push(JSON.parse(value));
  assert.deepEqual(values, [{ text: "🌍" }]);
});

test("a truncated SSE response cannot masquerade as success", async () => {
  const fetcher = (async () =>
    new Response(
      'data: {"type":"run.started","provider":"mock","model":"demo","runId":"r","sequence":1,"timestamp":"now"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;
  const client = new AgenticClient({
    url: "https://example.com",
    token,
    fetch: fetcher,
  });
  await assert.rejects(
    async () => {
      for await (const _event of client.stream(request)) {
        /* Consume to EOF. */
      }
    },
    { code: "INCOMPLETE_STREAM" },
  );
});
