// One explicitly selected native account, model and permitted source. No retry.
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connectedClient } from "@agenticdriver/sdk/connections";
import { validateSourceCitations } from "@agenticdriver/sdk/context";
const { values } = parseArgs({
  options: {
    connection: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    source: { type: "string" },
    prompt: { type: "string" },
    receipt: { type: "string" },
    query: { type: "string" },
  },
});
for (const name of [
  "connection",
  "provider",
  "model",
  "source",
  "prompt",
  "receipt",
])
  if (!values[name]) throw new Error(`Provide --${name}.`);
const file = await open(values.receipt, "wx", 0o600);
const receipt = { startedAt: new Date().toISOString(), events: {} };
try {
  const client = await connectedClient(values.connection);
  const provider = (await client.providers({ refresh: true })).find(
    (item) => item.id === values.provider,
  );
  assert(
    provider &&
      provider.modelCatalog?.source === "provider" &&
      provider.modelCatalog.models.includes(values.model),
  );
  assert.equal(provider.connection?.account?.status, "signed-in");
  if (provider.models) assert(provider.models.includes(values.model));
  receipt.selection = {
    provider: provider.id,
    model: values.model,
    authMode: provider.authMode,
    runtime: provider.connection.runtime,
    subscription: provider.connection.account.subscription,
  };
  receipt.input = await readFile(values.prompt, "utf8");
  receipt.retrieval = {
    corpus: "release-library",
    sourceIds: [values.source],
    limit: 4,
    ...(values.query ? { query: await readFile(values.query, "utf8") } : {}),
  };
  for await (const event of client.stream({
    provider: provider.id,
    model: values.model,
    input: receipt.input,
    retrieval: receipt.retrieval,
    outputArtifact: { name: "grounded-answer.md", mediaType: "text/markdown" },
    retry: { maxAttempts: 1 },
    maxSteps: 1,
  })) {
    receipt.events[event.type] = (receipt.events[event.type] ?? 0) + 1;
    if (event.type === "run.started") receipt.runId = event.runId;
    if (event.type === "run.completed") receipt.result = event.result;
    if (event.type === "run.failed" || event.type === "run.cancelled")
      throw Object.assign(new Error(event.error.message), event.error);
  }
  assert(receipt.result?.text?.trim());
  assert(receipt.result.retrieval.hits.length);
  assert(
    receipt.result.retrieval.hits.every(
      (hit) => hit.source.id === values.source,
    ),
  );
  assert(
    receipt.result.sources.every(
      (source) =>
        source.origin === "retrieval" &&
        source.location.documentId === values.source,
    ),
  );
  receipt.citations = validateSourceCitations(
    receipt.result.text,
    receipt.result.sources.map((source) => source.id),
    { requireCitation: true },
  );
  receipt.success = true;
  console.log(
    JSON.stringify({
      success: true,
      runId: receipt.result.runId,
      usage: receipt.result.usage,
      sourceCount: receipt.result.sources.length,
      citedSources: receipt.citations.length,
    }),
  );
} catch (error) {
  receipt.success = false;
  receipt.error = { code: error.code, message: error.message };
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  await file.close();
}
