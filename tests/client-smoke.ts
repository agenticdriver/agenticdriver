import assert from "node:assert/strict";
import { AgenticClient } from "../src/client.js";
const client = new AgenticClient({
  url: process.env.AGENTICDRIVER_TEST_URL!,
  token: process.env.AGENTICDRIVER_TEST_TOKEN!,
});
assert.equal((await client.providers())[0]?.id, "mock");
const refreshed = (await client.providers({ refresh: true }))[0]!;
assert.equal(refreshed.health?.code, "DISCOVERY_UNSUPPORTED");
assert.equal(refreshed.modelCatalog?.source, "configured");
assert.equal((await client.protocol()).version, "1.0");
const request = {
  provider: "mock",
  model: "demo",
  input: "Unicode 🌍 round trip",
  idleTimeoutMs: 10_000,
};
assert.equal((await client.run(request)).text, "AgenticDriver is connected.");
const keyed = {
  ...request,
  idempotencyKey: "typescript-client",
  retry: { maxAttempts: 1 },
};
const accepted = await client.run(keyed);
assert.deepEqual(await client.run(keyed), accepted);
await assert.rejects(client.run({ ...keyed, input: "changed" }), {
  code: "IDEMPOTENCY_CONFLICT",
});
await assert.rejects(
  client.run({ ...request, input: "conformance-uncertain" }),
  { code: "IDLE_TIMEOUT", outcome: "uncertain", retryable: false },
);
const types = [];
for await (const event of client.stream(request)) types.push(event.type);
assert.equal(types.at(-1), "run.completed");
console.log("TypeScript client: catalog, run, stream passed");

assert.deepEqual((await client.providers())[0]!.inputMediaTypes?.demo, [
  "image/png",
  "application/pdf",
]);
const contextual = await client.run({
  ...request,
  attachments: [
    {
      type: "reference",
      id: "source-one",
      revision: "r1",
      mediaType: "text/markdown",
    },
    {
      type: "image",
      source: { id: "image-one", revision: "r1" },
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    },
    {
      type: "pdf",
      source: { id: "pdf-one", revision: "r1" },
      mediaType: "application/pdf",
      data: "JVBERi0xLjQKJSVFT0YK",
    },
  ],
  outputArtifact: { name: "answer.md", mediaType: "text/markdown" },
});
assert.deepEqual(
  contextual.sources?.map((source) => source.id),
  ["source-one", "image-one", "pdf-one"],
);
assert.equal(contextual.sources![0]!.location!.documentId, "doc-one");
assert.equal(contextual.artifacts![0]!.status, "draft");
assert.deepEqual(contextual.artifacts![0]!.sourceIds, [
  "source-one",
  "image-one",
  "pdf-one",
]);

const indexedSource = {
  corpus: "library",
  source: { id: "typescript-paper", revision: "r1" },
  chunks: [
    {
      id: "typescript-p1",
      text: "Solar batteries retain energy.",
      location: { page: 2 },
    },
  ],
};
assert.equal((await client.indexContext(indexedSource)).status, "indexed");
const search = {
  corpus: "library",
  sourceIds: ["typescript-paper"],
  query: "solar energy",
};
assert.equal(
  (await client.searchContext(search)).hits[0]!.chunkId,
  "typescript-p1",
);
const grounded = await client.run({
  provider: "mock",
  model: "demo",
  input: "Question",
  retrieval: search,
  outputArtifact: { name: "answer.md", mediaType: "text/markdown" },
});
assert.equal(grounded.retrieval!.hits[0]!.source.id, "typescript-paper");
assert.equal(grounded.sources![0]!.origin, "retrieval");
assert.deepEqual(grounded.artifacts![0]!.sourceIds, ["typescript-p1"]);
assert.equal(
  (
    await client.deleteContext({
      corpus: "library",
      sourceId: "typescript-paper",
      revision: "r1",
    })
  ).deleted,
  true,
);
assert.deepEqual((await client.searchContext(search)).hits, []);
