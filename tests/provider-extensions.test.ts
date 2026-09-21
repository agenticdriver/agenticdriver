import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import { configuredDriver, validateHostConfig } from "../src/host.js";
import {
  defineProviderExtension,
  providerEndpoint,
  readProviderResponse,
  type ProviderExtensionManifest,
  type ProviderContext,
  type ProviderRequest,
  type ProviderTurn,
} from "../src/provider-kit.js";
import { testProviderConformance } from "../src/provider-conformance.js";

const manifest: ProviderExtensionManifest = {
  id: "independent",
  name: "Independent adapter",
  version: "1.2.3",
  contractVersion: "1.0",
  vendor: "enterprise",
  authMode: "api-key",
  usageSource: "adapter-report",
  capabilities: { tools: true, textStreaming: true },
};
const options = { id: "account-one", models: ["selected-model"] };
const request: ProviderRequest = {
  model: "selected-model",
  messages: [{ role: "user", content: "question" }],
  tools: [],
  maxOutputTokens: 100,
};
const run = { provider: options.id, model: request.model, input: "question" };
const context = (signal = new AbortController().signal): ProviderContext => ({
  signal,
  subject: "alice",
  runId: "run",
  reportProgress() {},
  emitText() {},
});

test("extensions snapshot version, models and settings, and reject invalid host policy", async () => {
  const declaration = structuredClone(manifest),
    settings = { endpoint: "https://enterprise.example" };
  let snapshot: unknown;
  const extension = defineProviderExtension(declaration, (received) => {
    snapshot = received.settings;
    assert.throws(
      () => (received.models as string[]).push("injected"),
      TypeError,
    );
    return {
      async complete() {
        return { text: "answer" };
      },
    };
  });
  declaration.capabilities.tools = false;
  const models = [...options.models];
  const adapter = extension.create({ ...options, models, settings });
  models.push("later-model");
  settings.endpoint = "https://changed.example";
  assert.deepEqual(snapshot, { endpoint: "https://enterprise.example" });
  assert.equal(adapter.info.capabilities.tools, true);
  assert.throws(() => adapter.info.models!.push("injected"), TypeError);
  await assert.rejects(
    adapter.complete({ ...request, model: "later-model" }, context()),
    { code: "UNSUPPORTED_MODEL" },
  );
  for (const value of [
    { ...options, models: [] },
    { ...options, models: ["duplicate", "duplicate"] },
    { ...options, models: ["bad model"] },
    { ...options, settings: { value: NaN } },
    { ...options, settings: { value: "x".repeat(128_000) } },
  ])
    assert.throws(() => extension.create(value), {
      code: "INVALID_PROVIDER_EXTENSION",
    });
  assert.throws(
    () =>
      defineProviderExtension(
        {
          ...manifest,
          contractVersion: "2.0",
        } as unknown as ProviderExtensionManifest,
        () => ({
          async complete() {
            return { text: "" };
          },
        }),
      ),
    { code: "INVALID_PROVIDER_EXTENSION" },
  );
});

test("the adapter boundary rejects malformed outputs and capability/stream contradictions", async () => {
  for (const turn of [
    { text: "", usage: { inputTokens: -1 } },
    { text: "", toolCalls: [{ id: "t", name: "broken name", arguments: {} }] },
    { text: "x".repeat(2_000_001) },
    { text: "", native: { invalid: undefined } },
    { text: "", undisclosed: "private" },
  ]) {
    const adapter = defineProviderExtension(manifest, () => ({
      async complete() {
        return turn as ProviderTurn;
      },
    })).create(options);
    await assert.rejects(adapter.complete(request, context()), {
      code: "INVALID_PROVIDER_RESULT",
    });
  }
  for (const mode of [
    "wrong-final",
    "undeclared-text",
    "undeclared-tools",
    "oversized-stream",
  ] as const) {
    const adapter = defineProviderExtension(
      {
        ...manifest,
        capabilities: {
          tools: mode !== "undeclared-tools",
          textStreaming: mode !== "undeclared-text",
        },
      },
      () => ({
        async complete(_request, ctx) {
          if (mode === "undeclared-tools")
            return {
              text: "",
              toolCalls: [{ id: "t", name: "write", arguments: {} }],
            };
          try {
            ctx.emitText(
              mode === "oversized-stream" ? "x".repeat(2_000_001) : "visible",
            );
          } catch {
            /* Cannot swallow the kit's policy failure. */
          }
          return { text: mode === "wrong-final" ? "different" : "visible" };
        },
      }),
    ).create(options);
    await assert.rejects(adapter.complete(request, context()), {
      code: "INVALID_PROVIDER_RESULT",
    });
    if (mode === "undeclared-tools")
      await assert.rejects(
        adapter.complete(
          {
            ...request,
            tools: [{ name: "write", description: "Write", inputSchema: {} }],
          },
          context(),
        ),
        { code: "UNSUPPORTED_TOOLS" },
      );
  }
});

test("cancellation bounds noncooperative adapters and suppresses late text and progress", async () => {
  let saved!: ProviderContext, ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const adapter = defineProviderExtension(manifest, () => ({
    async inspect() {
      return new Promise(() => {});
    },
    async complete(_request, ctx) {
      saved = ctx;
      ready();
      return new Promise(() => {});
    },
  })).create(options);
  let text = 0,
    progress = 0;
  const controller = new AbortController();
  const result = adapter.complete(request, {
    ...context(controller.signal),
    emitText() {
      text++;
    },
    reportProgress() {
      progress++;
    },
  });
  await started;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  saved.emitText("late private output");
  saved.reportProgress();
  assert.equal(text, 0);
  assert.equal(progress, 0);
  const probe = new AbortController(),
    inspected = adapter.inspect!({ signal: probe.signal });
  probe.abort();
  await assert.rejects(inspected, { name: "AbortError" });
});

test("host registration requires the pinned contract and restricts credential aliases", async () => {
  let resolved = 0;
  const extension = defineProviderExtension(manifest, ({ getSecret }) => ({
    async complete(_request, ctx) {
      assert.equal(await getSecret!("key", ctx.signal), "fixture-secret");
      await assert.rejects(getSecret!("unconfigured", ctx.signal), {
        code: "AUTH_REQUIRED",
      });
      return { text: "answer" };
    },
  }));
  const config = validateHostConfig({
    version: 1,
    usage: { hostId: "extension-test" },
    providers: [
      {
        kind: "extension",
        ...options,
        accountId: "shared-account",
        extensionId: manifest.id,
        extensionVersion: manifest.version,
        secretRefs: { key: { env: "SYNTHETIC_ONLY" } },
      },
    ],
    tokens: [
      {
        id: "app",
        subject: "alice",
        providers: [options.id],
        tokenRef: { env: "APP" },
      },
    ],
  });
  const registry = new Map([[manifest.id, extension]]);
  assert.throws(() => configuredDriver(config, "/unused/config.json"), {
    code: "PROVIDER_EXTENSION_UNAVAILABLE",
  });
  const mismatch = structuredClone(config);
  const entry = mismatch.providers[0]!;
  assert.equal(entry.kind, "extension");
  if (entry.kind === "extension") entry.extensionVersion = "9.0.0";
  assert.throws(
    () =>
      configuredDriver(mismatch, "/unused/config.json", {
        extensions: registry,
      }),
    { code: "PROVIDER_EXTENSION_UNAVAILABLE" },
  );
  const driver = configuredDriver(config, "/unused/config.json", {
    extensions: registry,
    secrets: async (reference) => {
      resolved++;
      assert.deepEqual(reference, { env: "SYNTHETIC_ONLY" });
      return "fixture-secret";
    },
  });
  assert.equal(resolved, 0, "Registration must not read credentials");
  assert.equal((await driver.run(run)).text, "answer");
  assert.equal(resolved, 1);
  assert.equal(
    JSON.stringify(driver.listProviders()).includes("fixture-secret"),
    false,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(driver.run(run, { signal: cancelled.signal }), {
    code: "CANCELLED",
  });
  assert.equal(resolved, 1);
});

test("endpoint and response helpers reject credential-bearing URLs, remote HTTP and oversized/invalid UTF-8", async () => {
  assert.equal(
    providerEndpoint("http://127.0.0.1:8080/api").href,
    "http://127.0.0.1:8080/api/",
  );
  for (const endpoint of [
    "http://remote.example",
    "https://user:secret@example.com",
    "https://example.com?secret=key",
    "https://example.com#fragment",
    "file:///etc/passwd",
  ])
    assert.throws(() => providerEndpoint(endpoint), {
      code: "INSECURE_TRANSPORT",
    });
  await assert.rejects(readProviderResponse(new Response("1234"), 3), {
    code: "RESPONSE_TOO_LARGE",
  });
  await assert.rejects(
    readProviderResponse(new Response(new Uint8Array([0xff]))),
    { code: "INVALID_RESPONSE" },
  );
});

test("the packaged conformance harness reports unsupported optional capabilities and fails bad fixtures", async () => {
  const extension = defineProviderExtension(
    { ...manifest, capabilities: { tools: false, textStreaming: true } },
    () => ({
      async complete(input, ctx) {
        const prompt = input.messages.at(-1)?.content;
        if (prompt === "conformance:cancel") {
          ctx.reportProgress();
          return new Promise(() => {});
        }
        if (prompt === "conformance:private-error")
          throw new Error("conformance-secret-marker");
        const text =
          prompt === "conformance:structured" ? '{"ok":true}' : "Hello fixture";
        ctx.emitText(text);
        return { text };
      },
    }),
  );
  const report = await testProviderConformance({
    mode: "fixture",
    model: request.model,
    create: () => extension.create(options),
  });
  assert.deepEqual(report, {
    contractVersion: "1.0",
    checks: ["text", "structured", "private-error", "cancel"],
    skipped: ["tools", "native"],
  });
  await assert.rejects(
    testProviderConformance({
      mode: "fixture",
      model: request.model,
      create: () =>
        defineProviderExtension(manifest, () => ({
          async complete() {
            return { text: "wrong" };
          },
        })).create(options),
    }),
    { name: "AssertionError" },
  );
  let factorySignal!: AbortSignal;
  await assert.rejects(
    testProviderConformance({
      mode: "fixture",
      model: request.model,
      testTimeoutMs: 10,
      create: (_scenario, { signal }) => {
        factorySignal = signal;
        return new Promise(() => {});
      },
    }),
    { code: "CONFORMANCE_TIMEOUT" },
  );
  assert.equal(factorySignal.aborted, true);
  await assert.rejects(
    testProviderConformance({
      mode: "fixture",
      model: request.model,
      testTimeoutMs: 2_147_483_648,
      create: () => extension.create(options),
    }),
    { code: "INVALID_CONFORMANCE_CONFIG" },
  );
});

test("untyped provider exceptions are redacted while missing usage remains unknown", async () => {
  const adapter = defineProviderExtension(manifest, () => ({
    async complete() {
      throw new Error("private-credential-and-body");
    },
  })).create(options);
  const driver = new AgenticDriver({ providers: [adapter] });
  await assert.rejects(
    driver.run(run),
    (error: Error & { code?: string }) =>
      error.code === "INTERNAL_ERROR" &&
      !error.message.includes("private-credential"),
  );
});
