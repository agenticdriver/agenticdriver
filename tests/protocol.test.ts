import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AgenticClient } from "../src/client.js";
import { AgenticDriver } from "../src/driver.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

const token = "compatibility-token-with-at-least-32-characters";
const request = { provider: "mock", model: "demo", input: "Hello" };
const fixture = JSON.parse(
  await readFile(
    new URL("../protocol/fixtures/versioning.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    id: string;
    headers: Record<string, string>;
    status?: number;
    events?: unknown[];
    json?: unknown;
    expectedTypes?: string[];
    expectedError?: string;
    retryable?: boolean;
  }[];
};

for (const example of fixture.cases) {
  test(`protocol compatibility: ${example.id}`, async () => {
    const client = new AgenticClient({
      url: "https://driver.example",
      token,
      fetch: (async (_url, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("AgenticDriver-Version"), PROTOCOL_VERSION);
        assert.equal(
          headers.get("AgenticDriver-Accept-Optional-Events"),
          "true",
        );
        return new Response(
          example.events
            ? example.events
                .map((e) => `data: ${JSON.stringify(e)}\n\n`)
                .join("")
            : JSON.stringify(example.json),
          {
            status: example.status ?? 200,
            headers: {
              "Content-Type": example.events
                ? "text/event-stream"
                : "application/json",
              ...example.headers,
            },
          },
        );
      }) as typeof fetch,
    });
    const consume = async () => {
      const events = [];
      for await (const event of client.stream(request)) events.push(event);
      assert.deepEqual(
        events.map((event) => event.type),
        example.expectedTypes,
      );
      const last = events.at(-1);
      assert.equal(last?.type, "run.completed");
      if (last?.type === "run.completed")
        assert.equal(last.result.text, "Hello 🌍");
    };
    if (example.expectedError) {
      await assert.rejects(consume, {
        code: example.expectedError,
        ...(example.retryable === undefined
          ? {}
          : { retryable: example.retryable }),
      });
    } else await consume();
  });
}

test("version and provider requirements are checked before any execution", async () => {
  let calls = 0;
  const adapter = mockProvider(() => {
    calls++;
    return { text: "accepted" };
  });
  adapter.info.capabilities.textStreaming = false;
  const driver = new AgenticDriver({ providers: [adapter] });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
    allowedOrigins: ["https://app.example"],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    const info = await client.protocol();
    assert.equal(info.version, PROTOCOL_VERSION);
    assert.deepEqual(info.supportedVersions, [PROTOCOL_VERSION]);
    assert.ok(info.features.includes("optional-idle-timeout"));
    for (const version of ["2.0", "1.1", "1.0, 2.0", "invalid"]) {
      const response = await fetch(server.url + "/v1/runs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "AgenticDriver-Version": version,
        },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("AgenticDriver-Version"), "1.0");
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "UNSUPPORTED_PROTOCOL_VERSION",
      );
    }
    for (const requiredCapabilities of [
      ["textStreaming"],
      ["futureCapability"],
    ]) {
      await assert.rejects(client.run({ ...request, requiredCapabilities }), {
        code: "UNSUPPORTED_CAPABILITY",
      });
      await assert.rejects(driver.run({ ...request, requiredCapabilities }), {
        code: "UNSUPPORTED_CAPABILITY",
      });
    }
    assert.equal(calls, 0);
    assert.equal(
      (await client.run({ ...request, requiredCapabilities: ["tools"] })).text,
      "accepted",
    );
    const legacy = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    assert.equal(legacy.status, 200);
    assert.equal(((await legacy.json()) as { text: string }).text, "accepted");
    assert.equal(calls, 2);
    const cors = await fetch(server.url + "/v1/protocol", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    });
    assert.ok(
      cors.headers
        .get("Access-Control-Allow-Headers")
        ?.includes("AgenticDriver-Version"),
    );
    assert.ok(
      cors.headers
        .get("Access-Control-Expose-Headers")
        ?.includes("AgenticDriver-Version"),
    );
  } finally {
    await server.close();
  }
});

test("optional extensions still obey envelope sequencing and run identity", async () => {
  for (const badEnvelope of [
    { sequence: 3 },
    { runId: "another-run" },
    { optional: "true" },
  ]) {
    const started = {
      type: "run.started",
      provider: "mock",
      model: "demo",
      runId: "r",
      sequence: 1,
      timestamp: "2026-09-20T12:00:00Z",
    };
    const optional = {
      type: "future.advisory",
      runId: "r",
      sequence: 2,
      timestamp: started.timestamp,
      optional: true,
      ...badEnvelope,
    };
    const client = new AgenticClient({
      url: "https://driver.example",
      token,
      fetch: (async () =>
        new Response(
          [started, optional]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        )) as typeof fetch,
    });
    await assert.rejects(
      async () => {
        for await (const _event of client.stream(request)) {
        }
      },
      { code: "INVALID_STREAM" },
    );
  }
});

test("generated OpenAPI components resolve recursive JSON tool and approval schemas", async () => {
  const document = JSON.parse(
    await readFile(
      new URL("../protocol/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(document, "openapi");
  const validate = ajv.compile({
    $ref: "openapi#/components/schemas/ToolExecutionResult",
  });
  const identity = { executionId: "execution", runId: "run", callId: "call" };
  for (const output of [
    null,
    1,
    "text",
    [true, { nested: [1, null] }],
    { passages: ["evidence"] },
  ])
    assert.equal(
      validate({ ...identity, output }),
      true,
      ajv.errorsText(validate.errors),
    );
  assert.equal(
    validate({ ...identity, error: "APPLICATION_TOOL_FAILED" }),
    true,
  );
  for (const result of [
    identity,
    { ...identity, output: null, subject: "forged" },
    { ...identity, output: null, error: "APPLICATION_TOOL_FAILED" },
    { ...identity, error: "private details" },
  ])
    assert.equal(validate(result), false);
  for (const name of [
    "ToolExecutionRequest",
    "ToolExecutionReceipt",
    "ApplicationToolDefinition",
    "ApplicationToolGrant",
    "ApprovalRequest",
    "ApprovalDecision",
    "ApprovalResolution",
    "RunEvent",
    "RunRequest",
  ])
    assert.doesNotThrow(() =>
      ajv.compile({ $ref: `openapi#/components/schemas/${name}` }),
    );
});
