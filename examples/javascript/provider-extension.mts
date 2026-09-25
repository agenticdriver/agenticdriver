/** Run against a synthetic endpoint; no account, credentials or inference service needed. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AgenticClient } from "@agenticdriver/sdk/client";
import { configuredDriver, validateHostConfig } from "@agenticdriver/sdk/host";
import { serve } from "@agenticdriver/sdk/server";
import { testProviderConformance } from "@agenticdriver/sdk/provider-conformance";
import type { ProviderRequest } from "@agenticdriver/sdk/provider-kit";
import { customProvider } from "./custom-provider.mjs";

const secret = "synthetic-endpoint-secret",
  token = "extension-example-client-token-at-least-32-characters";
const model = "fixture-model";
let upstreamCalls = 0,
  cancelled = 0;
let cancelReceived!: () => void;
const cancelledAtEndpoint = new Promise<void>((resolve) => {
  cancelReceived = resolve;
});
const upstream = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  if (req.method === "GET" && req.url === "/enterprise/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([model, "not-enabled-on-host"]));
    return;
  }
  assert.equal(req.url, "/enterprise/complete");
  assert.equal(req.method, "POST");
  upstreamCalls++;
  let body = "";
  for await (const chunk of req) body += String(chunk);
  const input = JSON.parse(body) as ProviderRequest;
  assert.equal(input.model, model);
  const last = input.messages.at(-1)!;
  if (last.content === "conformance:private-error") {
    res.writeHead(500);
    res.end("conformance-secret-marker");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const frame = (data: unknown) => res.write(JSON.stringify(data) + "\n");
  if (last.content === "conformance:cancel") {
    res.once("close", () => {
      cancelled++;
      cancelReceived();
    });
    frame({ type: "progress" });
    return; // Stays open until the caller aborts; no synthetic heartbeat.
  }
  if (last.content === "conformance:tools") {
    assert.equal(input.tools[0]?.name, "conformance_lookup");
    frame({
      type: "result",
      turn: {
        text: "",
        toolCalls: [
          {
            id: "lookup-1",
            name: "conformance_lookup",
            arguments: { value: 7 },
          },
        ],
      },
    });
  } else if (last.role === "tool") {
    assert.equal(last.callId, "lookup-1");
    assert.deepEqual(JSON.parse(last.content), { receipt: 7 });
    frame({ type: "result", turn: { text: "tool receipt: 7" } });
  } else if (last.content === "conformance:structured") {
    frame({ type: "result", turn: { text: '{"ok":true}' } });
  } else if (last.content === "conformance:native") {
    frame({
      type: "result",
      turn: {
        text: "first visible reply",
        native: { state: "private-state-marker" },
      },
    });
  } else if (last.content === "conformance:native-followup") {
    assert.ok(
      input.messages.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.native).includes("private-state-marker"),
      ),
    );
    frame({ type: "result", turn: { text: "native state received" } });
  } else {
    frame({ type: "text", text: "Hello " });
    frame({ type: "text", text: "fixture" });
    frame({ type: "result", turn: { text: "Hello fixture" } });
  }
  res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}/enterprise/`;
try {
  const report = await testProviderConformance({
    mode: "fixture",
    model,
    create: () =>
      customProvider.create({
        id: "enterprise",
        models: [model],
        settings: { endpoint },
        getSecret: async () => secret,
      }),
  });
  assert.deepEqual(report.checks, [
    "text",
    "structured",
    "tools",
    "private-error",
    "cancel",
    "native",
  ]);
  assert.deepEqual(report.skipped, []);
  await cancelledAtEndpoint;
  assert.equal(cancelled, 1);

  const config = validateHostConfig({
    version: 1,
    usage: { hostId: "extension-example" },
    providers: [
      {
        kind: "extension",
        id: "enterprise",
        accountId: "example-account",
        models: [model],
        extensionId: "example-ndjson",
        extensionVersion: "1.0.0",
        settings: { endpoint },
        secretRefs: { apiKey: { env: "FIXTURE_ONLY" } },
      },
    ],
    tokens: [
      {
        id: "app",
        subject: "example",
        providers: ["enterprise"],
        tokenRef: { env: "APP_FIXTURE" },
      },
    ],
  });
  const driver = configuredDriver(config, "/unused/host.json", {
    extensions: new Map([[customProvider.manifest.id, customProvider]]),
    secrets: async () => secret,
  });
  const host = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "example", providers: ["enterprise"] }],
  });
  try {
    const client = new AgenticClient({ url: host.url, token });
    const discovery = await client.providers();
    assert.deepEqual(discovery[0]!.models, [model]);
    assert.deepEqual(discovery[0]!.modelCatalog!.models, [
      model,
      "not-enabled-on-host",
    ]);
    assert.equal(
      (
        await client.run({
          provider: "enterprise",
          model,
          input: "conformance:text",
        })
      ).text,
      "Hello fixture",
    );
    const before = upstreamCalls;
    for (const extra of [
      { endpoint: "https://elsewhere.invalid" },
      { settings: { endpoint: "https://elsewhere.invalid" } },
      { extensionId: "unregistered" },
    ]) {
      const response = await fetch(host.url + "/v1/runs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "enterprise",
          model,
          input: "hello",
          ...extra,
        }),
      });
      assert.equal(response.status, 400);
      const rejected = (await response.json()) as { error: { code: string } };
      assert.equal(rejected.error.code, "INVALID_REQUEST");
    }
    await assert.rejects(
      client.run({
        provider: "enterprise",
        model: "not-enabled-on-host",
        input: "hello",
      }),
      { code: "UNSUPPORTED_MODEL" },
    );
    assert.equal(
      upstreamCalls,
      before,
      "Remote callers cannot expand host endpoint/model policy",
    );
  } finally {
    await host.close();
  }
  console.log(
    "Installed independent extension: six conformance scenarios and scoped HTTP host passed",
  );
} finally {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}
