// Copied into a fresh external project by test-package.ts. Keeping the fixture
// as source text lets the repository typecheck before dist exists; only the
// independently installed package supplies these imports and declarations.
export const packageContract = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgenticDriver, type RunRequest } from "@agenticdriver/sdk";
import { AgenticClient } from "@agenticdriver/sdk/client";
import { serve } from "@agenticdriver/sdk/server";
import { HostConfigSchema } from "@agenticdriver/sdk/host";
import { mockProvider } from "@agenticdriver/sdk/providers";
import { UsageStatClient } from "@agenticdriver/sdk/usagestat";
import { providerPresentation, quotaPresentation, type UsageStatProvider } from "@agenticdriver/sdk/catalog";
import { createProviderAssetCache } from "@agenticdriver/sdk/provider-assets";
import { MemoryContextStore, type ContextAttachment } from "@agenticdriver/sdk/context";
import { IngestRequestSchema, type IngestRequest } from "@agenticdriver/sdk/ingestion";
import {
  RetrievalService,
  SqliteVectorStore,
  DeterministicEmbeddingAdapter,
  validRetrievalLinks,
  type RetrievalAuthorization,
  type RetrievalIndexRequest,
} from "@agenticdriver/sdk/retrieval";

const installed = await realpath(join(process.cwd(), "node_modules", "@agenticdriver/sdk"));
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
const exports: Record<string, string> = {};
for (const key of Object.keys(manifest.exports)) {
  const name = key === "." ? "@agenticdriver/sdk" : "@agenticdriver/sdk" + key.slice(1);
  const path = await realpath(fileURLToPath(import.meta.resolve(name)));
  const local = relative(installed, path);
  assert.ok(local.startsWith("dist" + sep), name + " must resolve inside the installed archive");
  assert.ok(Object.keys(await import(name)).length, name + " must expose runtime values");
  exports[name] = local.split(sep).join("/");
}
await assert.rejects(import("@agenticdriver/sdk" + "/dist/index.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
assert.equal(typeof AgenticClient, "function");
assert.equal(typeof serve, "function");
assert.equal(typeof HostConfigSchema.parse, "function");
assert.equal(typeof UsageStatClient, "function");

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pluginRoot = join(process.cwd(), "synthetic-provider");
await mkdir(pluginRoot);
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>';
const notice = "Synthetic package-contract fixture. CC0-1.0.";
await writeFile(join(pluginRoot, "icon.svg"), icon);
await writeFile(join(pluginRoot, "NOTICE.txt"), notice);
const metadata: UsageStatProvider = {
  id: "fixture",
  name: "Fixture provider",
  icon: { kind: "svg", path: "icon.svg", monochrome: true, supportsCurrentColor: true },
};
const assets = await createProviderAssetCache({
  root: pluginRoot,
  providers: [metadata],
  allowlist: [{ providerId: "fixture", variant: "monochrome", license: {
    id: "CC0-1.0", attribution: "Synthetic package-contract fixture", noticePath: "NOTICE.txt",
  } }],
});
assert.deepEqual(assets.missing, []);
const card = providerPresentation({
  id: "fixture-account", name: "Fixture", vendor: "fixture", authMode: "none", usageStatId: "fixture",
  capabilities: { tools: false, textStreaming: true },
}, { metadata, assets: assets.manifest, account: { id: "alice-account", label: "Alice" } });
assert.equal(card.icon.kind, "asset");
assert.equal(card.accountLabel, "Alice");
assert.ok(!JSON.stringify(card).includes(pluginRoot));
const asset = assets.manifest[0]!;
assert.equal(asset.sha256, hash(icon));
assert.equal(await assets.respond(new Request("https://fixture.invalid" + asset.src))!.text(), icon);
assert.equal(await assets.respond(new Request("https://fixture.invalid" + asset.license.noticeUrl))!.text(), notice);
const identity = { hostId: "host", provider: "fixture-account", accountId: "alice-account", subject: "alice" };
assert.equal(quotaPresentation(identity, undefined, { maxAgeMs: 60_000 }).state, "unavailable");
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
  ["alice", { namespace: "alice", sources: { paper: "r1", other: "r1", ingested: "doc-r1" } }],
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
  const document: IngestRequest = IngestRequestSchema.parse({
    corpus: "library", document: {
      type: "text", mediaType: "text/markdown",
      source: { id: "ingested", revision: "doc-r1", uri: "app://library/ingested" },
      text: "# Solar results\nSolar batteries retain energy.",
    },
  });
  const ingested = await sdk.ingestContext(document, { subject: "alice" });
  assert.equal(ingested.status, "indexed");
  assert.equal(ingested.ingestion.format, "markdown");
  assert.equal((await sdk.ingestContext(document, { subject: "alice" })).status, "unchanged");
  await assert.rejects(sdk.ingestContext(document, { subject: "bob" }), { code: "CONTEXT_NOT_FOUND" });
  await store.close();
  store = await SqliteVectorStore.open(join(process.cwd(), "state", "vectors.db"));
  sdk = driver();
  const documentHits = await sdk.searchContext({
    corpus: "library", sourceIds: ["ingested"], query: "solar energy",
  }, { subject: "alice" });
  assert.equal(documentHits.hits.length, 1);
  assert.equal(documentHits.hits[0]!.ingestion!.inputSha256, ingested.ingestion.inputSha256);
  assert.equal(documentHits.hits[0]!.source.revision, "doc-r1");
  assert.equal(documentHits.hits[0]!.source.location!.section, "Solar results");

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
    workflow: "authorized context and ingestion, SQLite reopen, immutable revisions, selected retrieval and draft citations",
    catalog: "account identity, immutable approved assets and unavailable quota fallback",
    provider: "deterministic mock; no live requests",
    providerCalls,
    documentSha256: indexed.documentSha256,
  }));
} finally {
  contexts.clear();
  await store.close();
}
`;
