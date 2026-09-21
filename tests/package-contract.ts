// Copied into a fresh external project by test-package.ts. Keeping the fixture
// as source text lets the repository typecheck before dist exists; only the
// independently installed package supplies these imports and declarations.
export const packageContract = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgenticDriver, type RunRequest } from "agenticdriver";
import { AgenticClient } from "agenticdriver/client";
import { serve } from "agenticdriver/server";
import { HostConfigSchema } from "agenticdriver/host";
import { mockProvider } from "agenticdriver/providers";
import { UsageStatClient } from "agenticdriver/usagestat";
import { MemoryContextStore, type ContextAttachment } from "agenticdriver/context";
import {
  RetrievalService,
  SqliteVectorStore,
  DeterministicEmbeddingAdapter,
  validRetrievalLinks,
  type RetrievalAuthorization,
  type RetrievalIndexRequest,
} from "agenticdriver/retrieval";

const installed = await realpath(join(process.cwd(), "node_modules", "agenticdriver"));
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
const exports: Record<string, string> = {};
for (const key of Object.keys(manifest.exports)) {
  const name = key === "." ? "agenticdriver" : "agenticdriver" + key.slice(1);
  const path = await realpath(fileURLToPath(import.meta.resolve(name)));
  const local = relative(installed, path);
  assert.ok(local.startsWith("dist" + sep), name + " must resolve inside the installed archive");
  assert.ok(Object.keys(await import(name)).length, name + " must expose runtime values");
  exports[name] = local.split(sep).join("/");
}
await assert.rejects(import("agenticdriver" + "/dist/index.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
assert.equal(typeof AgenticClient, "function");
assert.equal(typeof serve, "function");
assert.equal(typeof HostConfigSchema.parse, "function");
assert.equal(typeof UsageStatClient, "function");

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const contexts = new MemoryContextStore();
const selected = {
  type: "text",
  mediaType: "text/markdown",
  source: {
    id: "selected-note",
    revision: "r1",
    uri: "app://library/note",
    location: { documentId: "note", startLine: 1, endLine: 1 },
  },
  text: "Synthetic selected note: evaluate solar storage evidence.",
} satisfies ContextAttachment;
const reference = contexts.put({
  attachment: selected,
  subjects: ["alice"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
let store = await SqliteVectorStore.open(join(process.cwd(), "state", "vectors.db"));
const grants = new Map<string, RetrievalAuthorization>([
  ["alice", { namespace: "alice", sources: { paper: "r1", other: "r1" } }],
  ["bob", { namespace: "bob", sources: { paper: "r1" } }],
]);
let providerCalls = 0;
function driver() {
  return new AgenticDriver({
    providers: [mockProvider((request) => {
      providerCalls++;
      assert.match(request.instructions ?? "", /untrusted reference data/);
      assert.equal(request.tools.length, 0);
      assert.ok(request.messages.some((message) => message.content.includes(selected.text)));
      assert.ok(request.messages.some((message) => message.content.includes("Solar batteries retain energy.")));
      return { text: "Synthetic summary [source:paper-p1]" };
    })],
    context: { resolve: contexts.resolve },
    retrieval: new RetrievalService([{
      id: "library",
      version: "v1",
      store,
      embedding: new DeterministicEmbeddingAdapter(32),
      authorize: (_, context) => grants.get(context.subject) ?? null,
    }]),
  });
}
let sdk = driver();
const paper: RetrievalIndexRequest = {
  corpus: "library",
  source: { id: "paper", revision: "r1", uri: "app://library/paper", title: "Synthetic solar paper" },
  chunks: [{ id: "paper-p1", text: "Solar batteries retain energy.", location: { page: 2 } }],
};
const request: RunRequest = {
  provider: "mock",
  model: "demo",
  input: "Summarize selected solar evidence",
  attachments: [reference],
  retrieval: { corpus: "library", sourceIds: ["paper"], query: "solar energy" },
  outputArtifact: { name: "review.md", mediaType: "text/markdown" },
};
try {
  const indexed = await sdk.indexContext(paper, { subject: "alice" });
  assert.equal(indexed.status, "indexed");
  assert.equal((await sdk.indexContext(paper, { subject: "alice" })).status, "unchanged");
  await assert.rejects(sdk.indexContext({
    ...paper, chunks: [{ id: "paper-p1", text: "Changed text under the same revision" }],
  }, { subject: "alice" }), { code: "SOURCE_CONFLICT" });
  await sdk.indexContext({
    ...paper, source: { id: "other", revision: "r1" },
    chunks: [{ id: "other-p1", text: "Unselected solar energy evidence" }],
  }, { subject: "alice" });
  await sdk.indexContext({
    ...paper, chunks: [{ id: "paper-p1", text: "Bob's private solar evidence" }],
  }, { subject: "bob" });
  await store.close();
  store = await SqliteVectorStore.open(join(process.cwd(), "state", "vectors.db"));
  sdk = driver();

  const result = await sdk.run(request, { subject: "alice" });
  assert.equal(result.text, "Synthetic summary [source:paper-p1]");
  assert.deepEqual(result.retrieval!.hits.map((hit) => hit.chunkId), ["paper-p1"]);
  assert.equal(result.retrieval!.hits[0]!.documentSha256, indexed.documentSha256);
  assert.equal(result.retrieval!.index.model, "lexical-hash-v1");
  assert.equal(validRetrievalLinks(result), true);
  const citation = result.sources!.find((source) => source.origin === "retrieval")!;
  assert.equal(citation.location!.documentId, "paper");
  assert.equal(citation.location!.page, 2);
  assert.equal(citation.uri, "app://library/paper");
  assert.equal(citation.revision, "r1");
  assert.equal(citation.sha256, hash(paper.chunks[0]!.text));
  assert.equal(result.sources!.find((source) => source.id === "selected-note")!.sha256, hash(selected.text));
  assert.equal(result.artifacts![0]!.status, "draft");
  assert.deepEqual(result.artifacts![0]!.sourceIds, ["selected-note", "paper-p1"]);
  assert.equal(result.artifacts![0]!.sha256, hash(result.text));
  assert.ok(!JSON.stringify(result).includes("Bob's private"));
  assert.ok(!JSON.stringify(result).includes("Unselected"));

  const query = { corpus: "library", sourceIds: ["paper"], query: "solar energy" };
  await assert.rejects(sdk.run(request, { subject: "bob" }), { code: "CONTEXT_NOT_FOUND" });
  await assert.rejects(sdk.searchContext(query, { subject: "mallory" }), { code: "CONTEXT_NOT_FOUND" });
  await assert.rejects(sdk.searchContext({ ...query, sourceIds: ["forbidden"] }, { subject: "alice" }), { code: "CONTEXT_NOT_FOUND" });
  assert.equal(providerCalls, 1, "Denied context must fail before provider execution");
  grants.get("alice")!.sources.paper = "r2";
  assert.deepEqual((await sdk.searchContext(query, { subject: "alice" })).hits, []);
  assert.equal(providerCalls, 1);
  console.log(JSON.stringify({
    exports,
    workflow: "authorized context, SQLite reopen, immutable revisions, selected retrieval and draft citations",
    provider: "deterministic mock; no live requests",
    providerCalls,
    documentSha256: indexed.documentSha256,
  }));
} finally {
  contexts.clear();
  await store.close();
}
`;
