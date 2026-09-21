import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import {
  MemoryContextStore,
  type ContextAttachment,
  type ContextReference,
} from "../src/context.js";
import { DriverError } from "../src/errors.js";
import { MemoryOperationStore } from "../src/operations.js";
import {
  mockProvider,
  openai,
  anthropic,
  gemini,
  openaiCompatible,
} from "../src/providers/index.js";
import { configuredDriver, validateHostConfig } from "../src/host.js";
import { serve } from "../src/server.js";
import type { ProviderRequest, UsageRecord } from "../src/types.js";

const request = {
  provider: "mock",
  model: "demo",
  input: "Summarize the selected context",
};
const text: ContextAttachment = {
  type: "text",
  mediaType: "text/markdown",
  source: {
    id: "passage-one",
    revision: "rev-one",
    uri: "app://library/paper-one",
    location: { documentId: "paper-one", startLine: 2, endLine: 3 },
  },
  text: "# Selected evidence\nReported finding.",
};
const image: ContextAttachment = {
  type: "image",
  mediaType: "image/png",
  source: { id: "brand-image", revision: "rev-one" },
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQZsAAAAASUVORK5CYII=",
};
// Minimal fixture PDF is transported as bytes. Parsing/OCR belongs to explicit ingestion adapters.
const pdf: ContextAttachment = {
  type: "pdf",
  mediaType: "application/pdf",
  source: { id: "paper", revision: "rev-one", location: { page: 1 } },
  data: Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
  ).toString("base64"),
};
const reference: ContextReference = {
  type: "reference",
  id: text.source.id,
  revision: text.source.revision,
  mediaType: text.mediaType,
};
const expires = () => new Date(Date.now() + 60_000).toISOString();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("selected Markdown is untrusted context with preserved provenance and a draft-only artifact", async () => {
  let received: ProviderRequest | undefined;
  const records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    providers: [
      mockProvider((input) => {
        received = input;
        return { text: "Reported finding [source:passage-one]" };
      }),
    ],
    onUsage: (record) => {
      records.push(record);
    },
  });
  const result = await driver.run({
    ...request,
    attachments: [text],
    outputArtifact: { name: "review.md", mediaType: "text/markdown" },
  });
  assert.match(received!.instructions!, /untrusted reference data/);
  assert.match(received!.messages.at(-1)!.content, /# Selected evidence/);
  assert.deepEqual(received!.tools, []);
  assert.equal(result.sources![0]!.sha256, sha(text.text));
  assert.deepEqual(result.sources![0]!.location, text.source.location);
  assert.deepEqual(result.artifacts![0]!.sourceIds, [text.source.id]);
  assert.equal(result.artifacts![0]!.status, "draft");
  assert.equal(result.artifacts![0]!.content, result.text);
  assert.equal(result.artifacts![0]!.sha256, sha(result.text));
  assert.ok(!JSON.stringify(records).includes("Selected evidence"));
  assert.ok(!JSON.stringify(records).includes("passage-one"));
});

test("inline preflight rejects unsupported modalities, paths, duplicate IDs, mismatched bytes and size excess before execution", async () => {
  let calls = 0;
  const adapter = mockProvider(() => {
    calls++;
    return { text: "ok" };
  });
  const driver = new AgenticDriver({ providers: [adapter] });
  await assert.rejects(driver.run({ ...request, attachments: [image] }), {
    code: "UNSUPPORTED_MODALITY",
  });
  await assert.rejects(driver.run({ ...request, attachments: [reference] }), {
    code: "CONTEXT_UNAVAILABLE",
  });
  await assert.rejects(driver.run({ ...request, attachments: [text, text] }), {
    code: "INVALID_CONTEXT",
  });
  await assert.rejects(
    driver.run({
      ...request,
      attachments: [{ ...text, text: "é".repeat(140_000) }],
    }),
    { code: "CONTEXT_TOO_LARGE" },
  );
  await assert.rejects(
    driver.run({
      ...request,
      attachments: [
        { ...text, source: { ...text.source, uri: "file:///etc/passwd" } },
      ],
    }),
    { code: "INVALID_REQUEST" },
  );
  await assert.rejects(
    driver.run({
      ...request,
      attachments: [
        {
          ...text,
          source: {
            ...text.source,
            uri: "https://name:secret@example.com/private",
          },
        },
      ],
    }),
    { code: "INVALID_CONTEXT" },
  );
  await assert.rejects(
    driver.run({
      ...request,
      attachments: [
        { ...text, source: { ...text.source, location: { pageEnd: 2 } } },
      ],
    }),
    { code: "INVALID_CONTEXT" },
  );
  await assert.rejects(
    driver.run({
      ...request,
      attachments: [{ ...image, data: "bm90LWFuLWltYWdl" }],
    }),
    { code: "INVALID_CONTEXT" },
  );
  for (const name of ["../accepted.md", "/tmp/accepted.md", ".."])
    await assert.rejects(
      driver.run({
        ...request,
        outputArtifact: { name, mediaType: "text/markdown" },
      }),
    );
  assert.equal(calls, 0);
});

test("reference authorization, immutable revisions, revocation and capacity are enforced by app-owned storage", async () => {
  const store = new MemoryContextStore({ maxEntries: 1, maxBytes: 1000 });
  store.put({ attachment: text, subjects: ["alice"], expiresAt: expires() });
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "answer" };
      }),
    ],
    context: { resolve: store.resolve },
  });
  await assert.rejects(
    driver.run({ ...request, attachments: [reference] }, { subject: "bob" }),
    { code: "CONTEXT_NOT_FOUND" },
  );
  assert.throws(
    () =>
      store.put({
        attachment: { ...text, text: "changed" },
        subjects: ["alice"],
        expiresAt: expires(),
      }),
    { code: "CONTEXT_CONFLICT" },
  );
  assert.throws(
    () =>
      store.put({
        attachment: { ...text, source: { id: "other", revision: "v1" } },
        subjects: ["alice"],
        expiresAt: expires(),
      }),
    { code: "CONTEXT_CAPACITY" },
  );
  assert.equal(
    (
      await driver.run(
        { ...request, attachments: [reference] },
        { subject: "alice" },
      )
    ).sources![0]!.origin,
    "reference",
  );
  store.put({
    attachment: { ...text, source: { ...text.source, revision: "rev-two" } },
    subjects: ["alice"],
    expiresAt: expires(),
  });
  await assert.rejects(
    driver.run({ ...request, attachments: [reference] }, { subject: "alice" }),
    { code: "CONTEXT_CHANGED" },
  );
  store.delete(text.source.id);
  await assert.rejects(
    driver.run({ ...request, attachments: [reference] }, { subject: "alice" }),
    { code: "CONTEXT_NOT_FOUND" },
  );
  assert.equal(calls, 1);
  store.clear();
});

test("expired and changed resolver leases are released without invoking a model", async () => {
  for (const lease of [
    { attachment: text, expiresAt: new Date(Date.now() - 1000).toISOString() },
    {
      attachment: {
        ...text,
        source: { ...text.source, revision: "different" },
      },
      expiresAt: expires(),
    },
    { attachment: { ...text, text: "x".repeat(100) }, expiresAt: expires() },
  ]) {
    let released = 0,
      calls = 0;
    const driver = new AgenticDriver({
      providers: [
        mockProvider(() => {
          calls++;
          return { text: "bad" };
        }),
      ],
      context: {
        maxTextBytes: 80,
        resolve: () => ({
          ...lease,
          release: () => {
            released++;
          },
        }),
      },
    });
    await assert.rejects(driver.run({ ...request, attachments: [reference] }));
    assert.equal(calls, 0);
    assert.equal(released, 1);
  }
});

test("cancelling during reference resolution releases a late lease exactly once", async () => {
  let resolveLease!: (value: {
      attachment: ContextAttachment;
      release(): void;
    }) => void,
    entered!: () => void,
    released = 0,
    calls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "bad" };
      }),
    ],
    context: {
      resolve: () => {
        entered();
        return new Promise((resolve) => {
          resolveLease = resolve;
        });
      },
    },
  });
  const running = driver.run(
    { ...request, attachments: [reference] },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(running, { code: "CANCELLED" });
  resolveLease({
    attachment: text,
    release: () => {
      released++;
    },
  });
  await delay(5);
  assert.equal(released, 1);
  assert.equal(calls, 0);
});

test("context progress resets an explicitly configured idle timeout and no idle timeout is enabled by default", async () => {
  const adapter = mockProvider(() => ({ text: "ok" }));
  const quiet = new AgenticDriver({
    providers: [adapter],
    context: {
      resolve: async () => {
        await delay(80);
        return { attachment: text };
      },
    },
  });
  await quiet.run({ ...request, attachments: [reference] });
  let released = 0;
  const active = new AgenticDriver({
    providers: [adapter],
    context: {
      resolve: async (_reference, context) => {
        for (let n = 0; n < 6; n++) {
          await delay(30, undefined, { signal: context.signal });
          context.reportProgress();
        }
        return {
          attachment: text,
          release: () => {
            released++;
          },
        };
      },
    },
  });
  await active.run({
    ...request,
    attachments: [reference],
    idleTimeoutMs: 120,
  });
  assert.equal(released, 1);
  const stalled = new AgenticDriver({
    providers: [adapter],
    context: { resolve: () => new Promise(() => {}) },
  });
  await assert.rejects(
    stalled.run({ ...request, attachments: [reference], idleTimeoutMs: 25 }),
    { code: "IDLE_TIMEOUT" },
  );
});

test("expired references and revoked access cannot be replayed", async () => {
  const store = new MemoryContextStore();
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "one" };
      }),
    ],
    context: { resolve: store.resolve },
    operations: new MemoryOperationStore(),
  });
  store.put({ attachment: text, subjects: ["local"], expiresAt: expires() });
  const keyed = {
    ...request,
    attachments: [reference],
    idempotencyKey: "context-operation",
  };
  const result = await driver.run(keyed);
  assert.deepEqual(await driver.run(keyed), result);
  store.clear();
  await assert.rejects(driver.run(keyed), { code: "CONTEXT_NOT_FOUND" });
  assert.equal(calls, 1);
  store.put({
    attachment: text,
    subjects: ["local"],
    expiresAt: new Date(Date.now() + 25).toISOString(),
  });
  await delay(70);
  await assert.rejects(driver.run({ ...request, attachments: [reference] }), {
    code: "CONTEXT_NOT_FOUND",
  });
  store.clear();
});

test("remote subjects use the same resolver and metadata is not a host filesystem or URL fetch request", async () => {
  const store = new MemoryContextStore();
  store.put({ attachment: text, subjects: ["alice"], expiresAt: expires() });
  const driver = new AgenticDriver({
    providers: [mockProvider()],
    context: { resolve: store.resolve },
  });
  const token = "context-token-with-at-least-32-characters",
    other = token + "-other";
  const server = await serve(driver, {
    port: 0,
    tokens: [
      { token, subject: "alice", providers: ["mock"] },
      { token: other, subject: "bob", providers: ["mock"] },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.ok(
      (await client.protocol()).features.includes("context-references"),
    );
    const result = await client.run({
      ...request,
      attachments: [reference],
      outputArtifact: { name: "answer.md", mediaType: "text/markdown" },
    });
    assert.equal(result.sources![0]!.uri, text.source.uri);
    assert.equal(result.artifacts![0]!.status, "draft");
    await assert.rejects(
      new AgenticClient({ url: server.url, token: other }).run({
        ...request,
        attachments: [reference],
      }),
      { code: "CONTEXT_NOT_FOUND" },
    );
  } finally {
    await server.close();
    store.clear();
  }
});

test("JSON artifacts require validated output and stay within the artifact byte budget", async () => {
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: '{"claim":"supported"}' }))],
  });
  const outputArtifact = {
    name: "claims.json",
    mediaType: "application/json" as const,
  };
  await assert.rejects(driver.run({ ...request, outputArtifact }), {
    code: "INVALID_ARTIFACT",
  });
  const result = await driver.run({
    ...request,
    outputArtifact,
    outputSchema: {
      type: "object",
      properties: { claim: { type: "string" } },
      required: ["claim"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(JSON.parse(result.artifacts![0]!.content), result.output);
  await assert.rejects(
    new AgenticDriver({
      providers: [mockProvider(() => ({ text: "x".repeat(262_145) }))],
    }).run({
      ...request,
      outputArtifact: { name: "large.md", mediaType: "text/markdown" },
    }),
    { code: "ARTIFACT_TOO_LARGE" },
  );
});

for (const kind of ["openai", "anthropic", "gemini", "compatible"] as const) {
  test(`${kind} sends native binary content and keeps it beside source labels across tool steps`, async () => {
    const bodies: any[] = [];
    const responses: Record<typeof kind, unknown[]> = {
      openai: [
        {
          status: "completed",
          output: [
            { type: "reasoning", encrypted_content: "signed" },
            {
              type: "function_call",
              call_id: "call1",
              name: "lookup",
              arguments: "{}",
            },
          ],
        },
        {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
        },
      ],
      anthropic: [
        {
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: "private", signature: "signed" },
            { type: "tool_use", id: "call1", name: "lookup", input: {} },
          ],
        },
        { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      ],
      gemini: [
        {
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    functionCall: { id: "call1", name: "lookup", args: {} },
                    thoughtSignature: "signed",
                  },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "done" }] } },
          ],
        },
      ],
      compatible: [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call1",
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ finish_reason: "stop", message: { content: "done" } }] },
      ],
    };
    const options = {
      apiKey: "fixture-no-real-key",
      models: ["vision", "text-only"],
      inputMediaTypes: {
        vision: [
          "image/png",
          ...(kind === "compatible" ? [] : ["application/pdf"]),
        ] as ("image/png" | "application/pdf")[],
      },
      fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify(responses[kind].shift()), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    };
    const adapter =
      kind === "openai"
        ? openai(options)
        : kind === "anthropic"
          ? anthropic(options)
          : kind === "gemini"
            ? gemini(options)
            : openaiCompatible({
                ...options,
                baseUrl: "https://fixture.example/v1/",
              });
    const attachments = kind === "compatible" ? [image] : [image, pdf];
    const driver = new AgenticDriver({
      providers: [adapter],
      tools: [
        {
          name: "lookup",
          description: "fixture",
          inputSchema: { type: "object" },
          execute: () => ({ ok: true }),
        },
      ],
    });
    await assert.rejects(
      driver.run({
        provider: adapter.info.id,
        model: "text-only",
        input: "hi",
        attachments,
      }),
      { code: "UNSUPPORTED_MODALITY" },
    );
    assert.equal(bodies.length, 0);
    const result = await driver.run({
      provider: adapter.info.id,
      model: "vision",
      input: "hi",
      attachments,
      tools: ["lookup"],
    });
    assert.equal(result.text, "done");
    for (const body of bodies) {
      const rendered = JSON.stringify(body);
      assert.ok(rendered.includes(image.data));
      assert.ok(rendered.includes(image.source.id));
      if (kind !== "compatible") assert.ok(rendered.includes(pdf.data));
    }
    if (kind === "openai") {
      assert.equal(bodies[0].input[0].content[2].type, "input_image");
      assert.ok(JSON.stringify(bodies[1]).includes("signed"));
      assert.equal(bodies[0].store, false);
    }
    if (kind === "anthropic") {
      assert.equal(bodies[0].messages[0].content[2].source.type, "base64");
      assert.ok(JSON.stringify(bodies[1]).includes("signed"));
    }
    if (kind === "gemini") {
      assert.equal(
        bodies[0].contents[0].parts[2].inlineData.mimeType,
        "image/png",
      );
      assert.ok(JSON.stringify(bodies[1]).includes("signed"));
    }
    if (kind === "compatible")
      assert.match(
        bodies[0].messages[1].content[2].image_url.url,
        /^data:image\/png;base64,/,
      );
  });
}

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

test("idempotent reconciliation rejects changed bytes under the same source revision", async () => {
  let body = "first",
    calls = 0,
    released = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "one" };
      }),
    ],
    operations: new MemoryOperationStore(),
    context: {
      resolve: () => ({
        attachment: { ...text, text: body },
        release: () => {
          released++;
        },
      }),
    },
  });
  const keyed = {
    ...request,
    attachments: [reference],
    idempotencyKey: "immutable-source",
  };
  await driver.run(keyed);
  body = "changed";
  await assert.rejects(driver.run(keyed), { code: "CONTEXT_CHANGED" });
  assert.equal(calls, 1);
  assert.equal(released, 2);
});
