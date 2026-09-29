// Explicit, opt-in qualification against a real trained model and a real PDF.
// This is not run by CI and never substitutes responses or vectors.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LocalEmbeddingAdapter,
  RetrievalService,
  SqliteVectorStore,
} from "../dist/retrieval.js";
import { PopplerPdfExtractor, prepareDocument } from "../dist/ingestion.js";

const { values } = parseArgs({
  options: {
    cache: { type: "string" },
    pdf: { type: "string" },
    state: { type: "string" },
    receipt: { type: "string" },
  },
});
for (const name of ["cache", "pdf", "state", "receipt"])
  if (!values[name])
    throw new Error(`Provide --${name}. No model is downloaded automatically.`);
const receiptFile = await open(values.receipt, "wx", 0o600);
const receipt = {
  startedAt: new Date().toISOString(),
  checks: {},
  generationRequests: 0,
};
const context = (
  subject = "research-reader",
  signal = new AbortController().signal,
  progress = () => {},
) => ({ subject, runId: randomUUID(), signal, reportProgress: progress });
const options = {
  providerId: "local-cpu",
  accountId: "rc-local-embeddings",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dimensions: 384,
  cacheDirectory: resolve(values.cache),
};
let store;
try {
  const embedding = new LocalEmbeddingAdapter(options);
  receipt.embedding = embedding.info;
  receipt.runtime = "@huggingface/transformers@4.3.0";
  const semantic = await embedding.embed(
    [
      "The release reconnects to the same selected account after a network outage.",
      "Connection recovery restores the selected account after disconnection.",
      "A sourdough bread loaf ferments overnight.",
    ],
    context(),
  );
  const cosine = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const related = cosine(semantic.vectors[0], semantic.vectors[1]);
  const unrelated = cosine(semantic.vectors[0], semantic.vectors[2]);
  assert(related > unrelated + 0.3);
  receipt.checks.semantic = { related, unrelated, usage: semantic.usage };

  const stop = new AbortController();
  let progressed = false;
  await assert.rejects(
    embedding.embed(
      ["Summarize the release's connection recovery."],
      context("research-reader", stop.signal, () => {
        progressed = true;
        stop.abort();
      }),
    ),
  );
  assert(progressed && stop.signal.aborted);
  // A following real call proves cancellation released the worker and queue.
  await embedding.embed(["The selected connection stays explicit."], context());
  receipt.checks.cancellationAndRecovery = true;
  await assert.rejects(
    embedding.embed(["connection ".repeat(300)], context()),
    { code: "EMBEDDING_INPUT_TOO_LONG" },
  );
  receipt.checks.noSilentTruncation = true;
  await assert.rejects(
    new LocalEmbeddingAdapter({ ...options, revision: "0".repeat(40) }).embed(
      ["A missing pinned model must fail."],
      context(),
    ),
    { code: "EMBEDDING_MODEL_UNAVAILABLE" },
  );
  receipt.checks.noModelFallback = true;

  await mkdir(values.state, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(resolve(values.state), "local-retrieval-"),
  );
  receipt.stateDirectory = directory;
  const database = join(directory, "vectors.sqlite");
  store = await SqliteVectorStore.open(database);
  const sources = {
    paper: "arxiv-2005.11401v4",
    guide: "rc-guide-v1",
    email: "handoff-v1",
  };
  const grants = new Map([
    ["research-reader", { namespace: "research", sources }],
    [
      "other-workspace",
      { namespace: "other-workspace", sources: { ...sources } },
    ],
  ]);
  const records = [];
  receipt.usage = records;
  const service = () =>
    new RetrievalService(
      [
        {
          id: "release-library",
          version: "minilm-q8-v1",
          store,
          embedding,
          authorize: (_request, ctx) => grants.get(ctx.subject) ?? null,
        },
      ],
      {
        usage: {
          hostId: "rc-local-retrieval",
          onUsage: (record) => {
            records.push(record);
          },
        },
      },
    );
  let retrieval = service();
  const pdf = await readFile(values.pdf);
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  assert.equal(
    pdfHash,
    "23e3249e9a1e75418d82efecab0ea8c4d033b89c93742f63208d47ce01f21233",
    "Use the unmodified https://arxiv.org/pdf/2005.11401v4 PDF for this qualification.",
  );
  const documents = [
    {
      type: "pdf",
      mediaType: "application/pdf",
      data: pdf.toString("base64"),
      source: {
        id: "paper",
        revision: sources.paper,
        title:
          "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
        uri: "https://arxiv.org/abs/2005.11401v4",
      },
    },
    {
      type: "text",
      mediaType: "text/markdown",
      text: await readFile(
        new URL("../docs/release-candidate.md", import.meta.url),
        "utf8",
      ),
      source: {
        id: "guide",
        revision: sources.guide,
        title: "AgenticDriver release candidate gates",
      },
    },
    {
      type: "email",
      threadId: "rc-handoff",
      source: {
        id: "email",
        revision: sources.email,
        title: "Release handoff planning example",
      },
      messages: [
        {
          id: "handoff-1",
          text: "From: Release coordinator\nSubject: AgenticDriver candidate review\nPlease review the Linux x64 candidate using your selected Codex Luna or Claude Haiku account. Keep stable npm latest on 0.1.0. The PyPI organization is still awaiting approval. Please record persisted app results and cancellation recovery before signing off.",
        },
        {
          id: "handoff-2",
          text: "From: App maintainer\nSubject: Re: AgenticDriver candidate review\nI will run the public-paper and release-note workflows in a disposable workspace. I will not use private mailbox data or send email. I will report the exact package, account, model, run IDs and usage with the acceptance receipt.",
        },
      ],
    },
  ];
  const prepared = [];
  receipt.preparedDocuments = prepared;
  receipt.documents = [];
  for (const document of documents) {
    const request = await prepareDocument(
      { corpus: "release-library", document, chunking: { maxBytes: 512 } },
      { pdf: new PopplerPdfExtractor(), maxChunkBytes: 512 },
      { maxBytes: 2_000_000, maxTextBytes: 1_000_000 },
      context(),
    );
    prepared.push(request);
    const result = await retrieval.index(request, context());
    receipt.documents.push({
      ...result,
      ...(document.type === "pdf" ? { inputSha256: pdfHash } : {}),
    });
    assert.equal(result.status, "indexed");
    const recordCount = records.length;
    assert.equal(
      (await retrieval.index(request, context())).status,
      "unchanged",
    );
    assert.equal(records.length, recordCount);
  }
  receipt.checks.idempotentIndexWithoutEmbedding = true;
  const queries = [
    ["paper", "What is the difference between RAG-Sequence and RAG-Token?"],
    [
      "guide",
      "Which platforms and native providers does the release candidate qualify?",
    ],
    ["email", "What must app maintainers review before release sign-off?"],
  ];
  receipt.searches = [];
  for (const [sourceId, query] of queries) {
    const result = await retrieval.search(
      { corpus: "release-library", sourceIds: [sourceId], query, limit: 4 },
      context(),
    );
    assert(
      result.hits.length > 0 &&
        result.hits.every((hit) => hit.source.id === sourceId),
    );
    assert(
      result.hits.every((hit) => hit.source.location?.documentId === sourceId),
    );
    if (sourceId === "paper")
      assert(result.hits.every((hit) => hit.source.location.page >= 1));
    if (sourceId === "email")
      assert(result.hits.every((hit) => hit.source.location.messageId));
    receipt.searches.push({ query, ...result });
  }
  const search = {
    corpus: "release-library",
    sourceIds: ["guide"],
    query: queries[1][1],
    limit: 4,
  };
  assert.equal(
    (await retrieval.search(search, context("other-workspace"))).hits.length,
    0,
  );
  await assert.rejects(retrieval.search(search, context("ungranted")), {
    code: "CONTEXT_NOT_FOUND",
  });
  await assert.rejects(
    retrieval.search({ ...search, sourceIds: ["missing-source"] }, context()),
    { code: "CONTEXT_NOT_FOUND" },
  );
  receipt.checks.namespaceAndSelectedSourceBoundaries = true;
  const changed = structuredClone(prepared[1]);
  changed.chunks[0].text += " Updated.";
  delete changed.ingestion;
  await assert.rejects(retrieval.index(changed, context()), {
    code: "SOURCE_CONFLICT",
  });
  receipt.checks.immutableRevision = true;
  const beforeRestart = await retrieval.search(search, context());
  await store.close();
  store = await SqliteVectorStore.open(database);
  retrieval = service();
  assert.deepEqual(await retrieval.search(search, context()), beforeRestart);
  receipt.checks.restartPersistence = true;
  await retrieval.revalidate(
    { corpus: search.corpus, sourceIds: ["guide"] },
    beforeRestart,
    context(),
  );
  sources.guide = "rc-guide-v2";
  await assert.rejects(
    retrieval.revalidate(
      { corpus: search.corpus, sourceIds: ["guide"] },
      beforeRestart,
      context(),
    ),
    { code: "CONTEXT_NOT_FOUND" },
  );
  assert.equal((await retrieval.search(search, context())).hits.length, 0);
  changed.source.revision = sources.guide;
  await retrieval.index(changed, context());
  assert(
    (await retrieval.search(search, context())).hits.every(
      (hit) => hit.source.revision === sources.guide,
    ),
  );
  receipt.checks.revisionChangeAndStaleEvidence = true;
  assert.equal(
    (
      await retrieval.delete(
        { corpus: search.corpus, sourceId: "guide", revision: sources.guide },
        context(),
      )
    ).deleted,
    true,
  );
  assert.equal((await retrieval.search(search, context())).hits.length, 0);
  receipt.checks.deletion = true;
  const mismatched = new RetrievalService([
    {
      id: "release-library",
      version: "incompatible-v2",
      store,
      embedding,
      authorize: () => ({ namespace: "research", sources }),
    },
  ]);
  await assert.rejects(mismatched.search(search, context()), {
    code: "INDEX_INCOMPATIBLE",
  });
  receipt.checks.incompatibleIndex = true;
  receipt.usage = records;
  receipt.preparedDocuments = prepared;
  receipt.completedAt = new Date().toISOString();
  receipt.success = true;
  console.log(
    JSON.stringify({
      success: true,
      checks: Object.keys(receipt.checks),
      documents: receipt.documents.map(({ sourceId, chunks }) => ({
        sourceId,
        chunks,
      })),
    }),
  );
} catch (error) {
  receipt.success = false;
  receipt.error = {
    code: error.code,
    message: error.message,
    stack: error.stack,
  };
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await store?.close();
  await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
  await receiptFile.close();
}
