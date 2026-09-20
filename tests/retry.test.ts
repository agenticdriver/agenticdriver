import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import { openai } from "../src/providers/openai.js";
import { mockProvider } from "../src/providers/mock.js";
import { retryDelay } from "../src/providers/retry.js";

const request = { provider: "openai", model: "chosen-model", input: "hello" };
const completed = () =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
    }),
  );

test("provider retries are opt-in, preserve model/body/credential, and honor Retry-After", async () => {
  let calls = 0,
    resolutions = 0,
    firstAt = 0;
  const bodies: string[] = [],
    headers: string[] = [];
  const adapter = openai({
    apiKey: () => `credential-${++resolutions}`,
    fetch: (async (_url, init) => {
      calls++;
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers).get("Authorization")!);
      if (calls === 1) {
        firstAt = Date.now();
        return new Response("rate-limited", {
          status: 429,
          headers: { "Retry-After": "0.025" },
        });
      }
      assert(Date.now() - firstAt >= 20);
      return completed();
    }) as typeof fetch,
  });
  const driver = new AgenticDriver({ providers: [adapter] });
  assert.equal(
    (
      await driver.run({
        ...request,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      })
    ).text,
    "done",
  );
  assert.equal(calls, 2);
  assert.equal(resolutions, 1);
  assert.deepEqual(headers, ["Bearer credential-1", "Bearer credential-1"]);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]!).model, "chosen-model");
  let defaultCalls = 0;
  const noRetry = new AgenticDriver({
    providers: [
      openai({
        apiKey: "test",
        fetch: (async () => {
          defaultCalls++;
          return new Response(null, { status: 429 });
        }) as typeof fetch,
      }),
    ],
  });
  await assert.rejects(noRetry.run(request), { code: "RATE_LIMITED" });
  assert.equal(defaultCalls, 1);
});

test("retry limits and server hints never turn into unbounded waits or early retries", async () => {
  for (const [hostAttempts, hint, expectedCalls] of [
    [2, "0", 2],
    [1, "0", 1],
    [5, "120", 1],
    [5, "invalid", 1],
  ] as const) {
    let calls = 0;
    const driver = new AgenticDriver({
      limits: { maxAttempts: hostAttempts },
      providers: [
        openai({
          apiKey: "test",
          fetch: (async () => {
            calls++;
            return new Response(null, {
              status: 429,
              headers: { "Retry-After": hint },
            });
          }) as typeof fetch,
        }),
      ],
    });
    await assert.rejects(
      driver.run({
        ...request,
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 100 },
      }),
      { code: "RATE_LIMITED" },
    );
    assert.equal(calls, expectedCalls);
  }
  const date = new Date(Date.now() + 10_000).toUTCString();
  assert.equal(
    retryDelay(new Headers({ "Retry-After": "10,20" }), 1, { maxAttempts: 2 }),
    undefined,
  );
  const wait = retryDelay(new Headers({ "Retry-After": date }), 1, {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 15_000,
  });
  assert(wait !== undefined && wait >= 8500 && wait <= 10_000);
});

test("cancellation and optional inactivity deadlines interrupt backoff without another attempt", async () => {
  for (const mode of ["cancel", "idle"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const driver = new AgenticDriver({
      providers: [
        openai({
          apiKey: "test",
          fetch: (async () => {
            calls++;
            if (mode === "cancel") setTimeout(() => controller.abort(), 20);
            return new Response(null, {
              status: 429,
              headers: { "Retry-After": "30" },
            });
          }) as typeof fetch,
        }),
      ],
    });
    await assert.rejects(
      driver.run(
        {
          ...request,
          retry: { maxAttempts: 3 },
          ...(mode === "idle" ? { idleTimeoutMs: 25 } : {}),
        },
        { signal: controller.signal },
      ),
      { code: mode === "cancel" ? "CANCELLED" : "IDLE_TIMEOUT" },
    );
    assert.equal(calls, 1);
  }
});

test("transport errors, 5xx responses and partial provider streams are never retried", async () => {
  for (const failure of ["network", "server", "stream"] as const) {
    let calls = 0;
    const driver = new AgenticDriver({
      providers: [
        openai({
          apiKey: "test",
          fetch: (async () => {
            calls++;
            if (failure === "network")
              throw new Error(
                "Uncertain whether provider accepted the request",
              );
            if (failure === "server")
              return new Response(null, { status: 503 });
            return new Response(
              'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }) as typeof fetch,
        }),
      ],
    });
    await assert.rejects(
      driver.run({ ...request, retry: { maxAttempts: 5, baseDelayMs: 0 } }),
    );
    assert.equal(calls, 1);
  }
});

test("retrying a rejected follow-up model request does not execute the preceding tool again", async () => {
  let calls = 0,
    effects = 0;
  const driver = new AgenticDriver({
    providers: [
      openai({
        apiKey: "test",
        fetch: (async (_url, init) => {
          calls++;
          if (calls === 1)
            return new Response(
              JSON.stringify({
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    call_id: "effect",
                    name: "write",
                    arguments: "{}",
                  },
                ],
              }),
            );
          const body = JSON.parse(String(init?.body));
          assert.equal(body.input.at(-1).type, "function_call_output");
          if (calls === 2)
            return new Response(null, {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          return completed();
        }) as typeof fetch,
      }),
    ],
    tools: [
      {
        name: "write",
        description: "effect",
        inputSchema: { type: "object" },
        execute: () => {
          effects++;
          return { saved: true };
        },
      },
    ],
  });
  await driver.run({
    ...request,
    tools: ["write"],
    retry: { maxAttempts: 2, baseDelayMs: 0 },
  });
  assert.equal(calls, 3);
  assert.equal(effects, 1);
  const unsupported = new AgenticDriver({ providers: [mockProvider()] });
  await assert.rejects(
    unsupported.run({
      provider: "mock",
      model: "demo",
      input: "hello",
      retry: { maxAttempts: 2 },
    }),
    { code: "UNSUPPORTED_CAPABILITY" },
  );
});
