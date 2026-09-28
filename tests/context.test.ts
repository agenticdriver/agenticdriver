import assert from "node:assert/strict";

import test from "node:test";

import { openai, openaiCompatible } from "../src/providers/index.js";

import { configuredDriver, validateHostConfig } from "../src/host.js";

test("host model configuration makes supported MIME types explicit and rejects incompatible claims", () => {
  assert.throws(
    () =>
      openaiCompatible({
        apiKey: "fixture",
        baseUrl: "https://fixture.example",
        models: ["a"],
        inputMediaTypes: { a: ["application/pdf"] },
      }),
    { code: "INVALID_CONTEXT_POLICY" },
  );
  assert.throws(
    () =>
      openai({
        apiKey: "fixture",
        models: ["a"],
        inputMediaTypes: { b: ["image/png"] },
      }),
    { code: "INVALID_CONTEXT_POLICY" },
  );
  const config = validateHostConfig({
    version: 1,
    providers: [
      {
        id: "openai",
        kind: "openai",
        models: ["a"],
        apiKeyRef: { env: "FIXTURE_KEY" },
        inputMediaTypes: { a: ["image/png"] },
      },
    ],
    tokens: [
      {
        id: "app",
        subject: "app",
        tokenRef: { env: "FIXTURE_TOKEN" },
        providers: ["openai"],
      },
    ],
    context: { maxBytes: 2048, maxTextBytes: 1024 },
  });
  assert.deepEqual(
    configuredDriver(config, "/tmp/config.json").listProviders()[0]!
      .inputMediaTypes,
    { a: ["image/png"] },
  );
});
