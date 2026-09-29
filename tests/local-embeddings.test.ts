import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEmbeddingAdapter } from "../src/local-embeddings.js";

const options = {
  providerId: "local-cpu",
  accountId: "document-index",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dimensions: 384,
  cacheDirectory: join(tmpdir(), "host-owned-model-cache"),
};
// Configuration/boundary checks only. Real inference is separately opt-in.
test("local embedding identity binds immutable weights, precision and pooling", () => {
  const adapter = new LocalEmbeddingAdapter(options);
  assert.equal(adapter.info.authMode, "none");
  assert.equal(adapter.info.accountId, "document-index");
  assert.equal(
    adapter.info.model,
    `${options.model}:${options.revision}:q8:mean`,
  );
  assert(Object.isFrozen(adapter.info));
  for (const patch of [
    { revision: "main" },
    { model: "../model" },
    { model: "https://example.org/model" },
    { cacheDirectory: "relative" },
    { dimensions: 0 },
    { maxTokens: 513 },
    { dimensions: 4097 },
    { maxTokens: 0 },
    { token: "unrecognized-setting" },
  ])
    assert.throws(() => new LocalEmbeddingAdapter({ ...options, ...patch }), {
      code: "INVALID_EMBEDDING_CONFIG",
    });
});

test("invalid inputs and already-cancelled calls never load a runtime", async () => {
  const adapter = new LocalEmbeddingAdapter(options);
  const controller = new AbortController();
  const context = {
    subject: "reader",
    runId: "boundary-check",
    signal: controller.signal,
    reportProgress() {},
  };
  await assert.rejects(adapter.embed([], context), {
    code: "INVALID_RETRIEVAL",
  });
  await assert.rejects(adapter.embed(["x".repeat(16_385)], context), {
    code: "INVALID_RETRIEVAL",
  });
  controller.abort();
  await assert.rejects(
    adapter.embed(["A cancelled indexing request."], context),
    { name: "AbortError" },
  );
});

test(
  "a shared model-cache directory is rejected before runtime loading",
  { skip: process.platform === "win32" },
  async () => {
    const cacheDirectory = await mkdtemp(
      join(tmpdir(), "ad-embedding-permissions-"),
    );
    try {
      await chmod(cacheDirectory, 0o755);
      const adapter = new LocalEmbeddingAdapter({ ...options, cacheDirectory });
      await assert.rejects(
        adapter.embed(["Release notes describe connection recovery."], {
          subject: "reader",
          runId: "boundary-check",
          signal: new AbortController().signal,
          reportProgress() {},
        }),
        { code: "EMBEDDING_CACHE_UNSAFE" },
      );
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  },
);
