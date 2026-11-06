import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RetrievalService,
  SqliteVectorStore,
  MemoryVectorStore,
  OpenAIEmbeddingAdapter,
} from "../src/retrieval.js";
import { AgenticDriver } from "../src/driver.js";
import { serve } from "../src/server.js";
import type { RetrievalCorpus } from "../src/retrieval.js";

const request = {
  corpus: "library",
  sourceId: "immutable-source",
  revision: "revision-1",
};
const context = () => ({
  runId: randomUUID(),
  subject: "app-subject",
  signal: new AbortController().signal,
  reportProgress() {},
});
function embedding() {
  let calls = 0;
  const adapter = new OpenAIEmbeddingAdapter({
    identity: {
      providerId: "configured-embeddings",
      vendor: "openai",
      accountId: "explicit-api-account",
      authMode: "api-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    baseUrl: "https://api.openai.com/v1",
    apiKey: () => {
      calls++;
      throw new Error(
        "Embedding execution is not authorized by this storage test",
      );
    },
  });
  return { adapter, calls: () => calls };
}
async function fixture(authorize?: RetrievalCorpus["authorize"]) {
  const directory = await mkdtemp(join(tmpdir(), "retirement-service-"));
  const store = await SqliteVectorStore.open(
    join(directory, "vectors.sqlite"),
    { retirement: { maxSources: 10 } },
  );
  const selected = embedding();
  const service = new RetrievalService([
    {
      id: "library",
      version: "passages-v1",
      embedding: selected.adapter,
      store,
      authorize:
        authorize ??
        (() => ({
          namespace: "project-a",
          sources: { [request.sourceId]: request.revision },
        })),
    },
  ]);
  return {
    store,
    service,
    selected,
    close: async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("retirement is authorized at its own operation and commits without embedding", async () => {
  const operations: string[] = [];
  const state = await fixture(({ operation, sourceIds }, ctx) => {
    operations.push(operation);
    assert.equal(ctx.subject, "app-subject");
    assert.deepEqual(sourceIds, [request.sourceId]);
    return operation === "retire"
      ? {
          namespace: "project-a",
          sources: { [request.sourceId]: request.revision },
        }
      : null;
  });
  try {
    assert.equal(state.service.supportsRetirement, true);
    assert.deepEqual(await state.service.retire(request, context()), {
      ...request,
      retired: true,
      deleted: false,
    });
    assert.deepEqual(await state.service.retire(request, context()), {
      ...request,
      retired: true,
      deleted: false,
    });
    assert.deepEqual(operations, ["retire", "retire", "retire", "retire"]);
    assert.equal(state.selected.calls(), 0);
  } finally {
    await state.close();
  }
});

test("retirement rechecks namespace/revision authority and denies stale decisions", async () => {
  let checks = 0;
  const state = await fixture(() => ({
    namespace: ++checks === 1 ? "project-a" : "project-b",
    sources: { [request.sourceId]: request.revision },
  }));
  try {
    await assert.rejects(state.service.retire(request, context()), {
      code: "CONTEXT_NOT_FOUND",
    });
    assert.equal(state.selected.calls(), 0);
    assert.equal(
      (
        await state.store.retire!(
          {
            corpus: request.corpus,
            namespace: "project-a",
            sources: { [request.sourceId]: "revision-2" },
          },
          request.sourceId,
          "revision-2",
          context(),
        )
      ).retired,
      true,
    );
  } finally {
    await state.close();
  }
});

test("retirement requires the exact authorized revision", async () => {
  const state = await fixture();
  try {
    await assert.rejects(
      state.service.retire(
        { ...request, revision: "wrong-revision" },
        context(),
      ),
      { code: "CONTEXT_NOT_FOUND" },
    );
    assert.deepEqual(await state.service.retire(request, context()), {
      ...request,
      retired: true,
      deleted: false,
    });
    assert.equal(state.selected.calls(), 0);
  } finally {
    await state.close();
  }
});

test("an authorized unfenced corpus refuses retirement instead of treating deletion as a fence", async () => {
  const selected = embedding();
  const service = new RetrievalService([
    {
      id: "library",
      version: "passages-v1",
      embedding: selected.adapter,
      store: new MemoryVectorStore(),
      authorize: () => ({
        namespace: "project-a",
        sources: { [request.sourceId]: request.revision },
      }),
    },
  ]);
  assert.equal(service.supportsRetirement, false);
  await assert.rejects(service.retire(request, context()), {
    code: "RETIREMENT_UNAVAILABLE",
  });
  assert.equal(selected.calls(), 0);
});

test("actual retirement HTTP route requires its own grant and advertises availability without granting access", async () => {
  const state = await fixture();
  const driver = new AgenticDriver({ providers: [], retrieval: state.service });
  const deletion = "delete-" + "a".repeat(32),
    retirement = "retire-" + "b".repeat(32);
  const host = await serve(driver, {
    host: "127.0.0.1",
    port: 0,
    tokens: [
      {
        token: deletion,
        subject: "app-subject",
        providers: [],
        retrieval: { delete: ["library"] },
      },
      {
        token: retirement,
        subject: "app-subject",
        providers: [],
        retrieval: { retire: ["library"] },
      },
    ],
  });
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  try {
    const protocol = await fetch(host.url + "/v1/protocol", {
      headers: headers(deletion),
    }).then((r) => r.json());
    assert(protocol.features.includes("retrieval-retirement"));
    const denied = await fetch(host.url + "/v1/retrieval/retire", {
      method: "POST",
      headers: headers(deletion),
      body: JSON.stringify(request),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "FORBIDDEN");
    const accepted = await fetch(host.url + "/v1/retrieval/retire", {
      method: "POST",
      headers: headers(retirement),
      body: JSON.stringify(request),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      ...request,
      retired: true,
      deleted: false,
    });
    assert.equal(state.selected.calls(), 0);
  } finally {
    await host.close();
    await state.close();
  }
});
