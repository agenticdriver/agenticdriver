# Scoped retrieval and vector indexes

AgenticDriver can [ingest PDF, Markdown and email sources](ingestion.md), index prepared passages, search an authorized corpus, and supply retrieved evidence to a generation run. Applications keep their canonical email threads, papers, Markdown, permissions and accepted answers. A retrieval corpus is a rebuildable index of that application data.

Use `@agenticdriver/sdk/retrieval` on the execution host. All four clients support `searchContext`/`search_context`, `indexContext`/`index_context`, `deleteContext`/`delete_context` and the `retrieval` run option. Remote calls use the existing authenticated HTTPS protocol. `scoped-retrieval` and `retrieval-indexing` appear in protocol discovery only when a service is configured.

## Configure a corpus

```ts
import { AgenticDriver } from "@agenticdriver/sdk";
import {
  RetrievalService,
  SqliteVectorStore,
  OpenAIEmbeddingAdapter,
} from "@agenticdriver/sdk/retrieval";

const store = await SqliteVectorStore.open("/private/app-state/library.db");
const embedding = new OpenAIEmbeddingAdapter({
  identity: {
    providerId: "research-embeddings",
    vendor: "openai",
    accountId: "research-api-account",
    authMode: "api-key",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  baseUrl: "https://api.openai.com/v1",
  apiKey: () => secrets.read("research-embedding-key"),
});
const retrieval = new RetrievalService([
  {
    id: "library",
    version: "passages-v1",
    embedding,
    store,
    authorize: async ({ operation, sourceIds }, context) => {
      // An app-owned permission check, including write/delete permission.
      // Never trust caller metadata or document text as a grant.
      return application.authorizedSourceRevisions({
        subject: context.subject,
        operation,
        selectedIds: sourceIds,
        signal: context.signal,
      });
      // Return null to deny, or:
      // { namespace: "workspace-123", sources: { "paper-1": "sha256-abcd..." } }
    },
  },
]);
const driver = new AgenticDriver({ providers, retrieval });
```

The embedding provider instance, vendor, account, authentication mode, model, dimensions, cosine metric and index version are fixed explicitly. They are separate from the generation model. Opening the same corpus with an incompatible descriptor fails before embedding. Use a new corpus or an app-managed rebuild; the SDK never silently converts vectors or changes billing accounts. Identifiers are non-secret labels, not API keys, email addresses or raw tokens.

The embedding adapter uses [OpenAI's embeddings request and response format](https://developers.openai.com/api/reference/resources/embeddings/methods/create): explicit model, float vectors, response index ordering and optional reported input tokens. It rejects a different returned model, dimensions, duplicate response indices, non-finite values and zero vectors. Set `sendDimensions: false` for models that require native dimensions and reject the request parameter. The configured output dimension is still checked. Provider input/token limits also apply. No subscription embedding entitlement is inferred, and neither failed embedding requests nor uncertain mutations are automatically retried.

`DeterministicEmbeddingAdapter(dimensions)` is a reproducible lexical hashing fixture for offline tests and examples. It is not a semantic model or evidence of live provider certification. Apps can implement `EmbeddingAdapter` and `VectorStore` for existing infrastructure. SQLite is the supplied persistent adapter; Qdrant, pgvector and other external databases are not built-in adapters yet.

## Index, search and ask

```ts
await driver.indexContext(
  {
    corpus: "library",
    source: { id: "paper-1", revision: "sha256-abcd", title: "Battery study" },
    chunks: [
      {
        id: "paper-1-passage-7",
        text: "The measured battery lifetime was ...",
        location: { page: 4, startLine: 80, endLine: 82 },
      },
    ],
  },
  { subject: "user-123" },
);

const evidence = await driver.searchContext(
  {
    corpus: "library",
    sourceIds: ["paper-1"],
    query: "battery lifetime",
    limit: 6,
    maxContextBytes: 32_768,
  },
  { subject: "user-123" },
);

const answer = await driver.run(
  {
    provider: "my-generation-account",
    model: "my-explicit-model",
    input: "What does the selected study report about battery lifetime?",
    retrieval: { corpus: "library", sourceIds: ["paper-1"], limit: 6 },
    outputArtifact: { name: "answer.md", mediaType: "text/markdown" },
  },
  { subject: "user-123" },
);
```

`query` defaults to the run input; standalone search requires it. With `sourceIds` omitted, search covers only the bounded source map returned by the app authorizer. Explicit selected IDs must all be authorized; unavailable and unauthorized sources use the same public error. Index a thread as one versioned source, or have the app translate its selected threads into message/document source IDs before calling the SDK; the authorizer validates those exact IDs.

Search applies namespace and exact current source revision filters before similarity ranking. After search and index reads, authorization is checked again before returning passages. Runs recheck the evidence before each generation step and before recording a completed answer. These are point-in-time checks: revocation cannot retract bytes already sent to a provider or streamed to a client. Apps must recheck source access and revisions when displaying or navigating saved citations.

Each hit contains `chunkId`, its original `source.id` and `source.revision`, citation location, exact passage text, `documentSha256` and cosine `score`. Score is a similarity measure, not confidence or proof of a claim. Chunk IDs must be unique within the corpus namespace and are app-issued for prepared indexing or deterministically generated by the ingestion helper. Run source manifests use the chunk ID for `[source:ID]` citations, retain `location.documentId`, and use `origin: "retrieval"`. Draft artifact `sourceIds` identify supplied passages; applications still validate claims, quote spans and accepted artifacts.

Retrieved text is labelled untrusted reference data. It cannot grant a tool, select another account or widen a corpus. No-evidence runs fail with `NO_RETRIEVAL_EVIDENCE` before generation; standalone search returns an empty list. A byte budget excludes complete passages rather than silently cutting quoted text. `truncated` indicates omitted matches due to the result limit or byte budget.

Indexing replaces one complete document revision atomically. Identical revision and content returns `unchanged` before embedding. Changed content or provenance under the same revision fails with `SOURCE_CONFLICT`. A concurrent replacement, chunk-ID collision or capacity failure preserves the previous document. Deletion requires the exact authorized revision:

```ts
await driver.deleteContext(
  {
    corpus: "library",
    sourceId: "paper-1",
    revision: "sha256-abcd",
  },
  { subject: "user-123" },
);
```

Allow deletion in the app authorizer before removing its revision grant, or retain an explicit authorized deletion tombstone. Do not authorize deletion by granting unrestricted search. Interrupted or unacknowledged mutations require reconciliation; retrying an identical index request can confirm `unchanged`. Changed revisions must come from the app's current canonical document. Completed idempotent runs reauthorize their recorded evidence without repeating embedding, generation, tools or generation metering. An interrupted run without a complete evidence snapshot refuses replay with `CONTEXT_REPLAY_UNAVAILABLE`; reconcile its effects in the application.

## Remote permissions and language clients

The host token must grant each corpus operation separately, in addition to application authorization:

```ts
const host = await serve(driver, {
  tokens: [
    {
      token: driverBearerToken,
      subject: "user-123",
      providers: ["my-generation-account"],
      retrieval: {
        search: ["library"],
        index: ["library"],
        delete: ["library"],
      },
    },
  ],
  tls: { key, cert },
  host: "0.0.0.0",
});
```

Omitted retrieval permissions deny access, including retrieval inside an otherwise allowed run. Token grants never expose a filesystem path or vector payload. Retrieval calls share host concurrency limits, cancellation on disconnect, body limits, origin checks and TLS policy with runs. `configuredDriver` accepts a programmatic retrieval service; a host JSON file alone cannot replace the application's authorizer. `configuredServer` reads the token's optional retrieval grants.

```python
evidence = client.search_context({
    "corpus": "library", "sourceIds": ["paper-1"], "query": "battery lifetime"
})
answer = client.run(provider="my-generation-account", model="my-explicit-model",
    input="What did it report?", retrieval={"corpus": "library", "sourceIds": ["paper-1"]})
```

```go
selection := agenticdriver.RetrievalRequest{Corpus: "library", SourceIDs: []string{"paper-1"}}
answer, err := client.Run(ctx, agenticdriver.Request{
    Provider: "my-generation-account", Model: "my-explicit-model",
    Input: "What did it report?", Retrieval: &selection,
})
```

```rust
let mut request = RunRequest::new("my-generation-account", "my-explicit-model", "What did it report?");
request.retrieval = Some(RetrievalRequest {
    corpus: "library".into(), source_ids: vec!["paper-1".into()], ..Default::default()
});
let answer = client.run(&request)?;
```

All clients preserve and validate retrieval metadata, scope, source-manifest relationships and `run.progress` with phase `context`. Runs have no default inactivity timeout or total deadline. Explicit `idleTimeoutMs` includes actual embedding, authorization and vector-scan progress; heartbeat comments do not reset it. Standalone calls have no execution deadline; ingestion also accepts an explicit inactivity timeout. TypeScript/Go accept caller cancellation. Python has [typed sync and asyncio clients](../clients/python/README.md), including async task cancellation and stream context managers. Rust has [native async and optional blocking clients](../clients/rust/README.md): dropping an async future or stream closes its response; blocking streams retain callback cancellation.

## Storage and limits

| Bound                                         | Default / maximum                                           |
| --------------------------------------------- | ----------------------------------------------------------- |
| Authorized/selected source revisions per call | 1,000                                                       |
| Chunks per indexed document                   | 256                                                         |
| Text per chunk or query                       | 16 KiB UTF-8                                                |
| Text per indexed document                     | 1 MiB UTF-8; remote JSON body also limited to 1 MB          |
| Embedding dimensions                          | 1–4,096                                                     |
| Retrieved passages                            | 8 by default; maximum 16 including explicit run attachments |
| Retrieved context text                        | 64 KiB by default; maximum 256 KiB                          |
| Store capacity across corpora/namespaces      | 20,000 chunks / 128 MiB serialized payload by default       |
| Configurable store capacity ceiling           | 1,000,000 chunks / 1 GiB payload                            |

Run-wide context budgets also apply. The SQLite adapter uses bounded exact cosine scans, not an ANN index. Capacity limits bound storage payload, not a latency guarantee or the total SQLite/WAL file size. It serializes connection work, scans only allowed revisions, yields between batches for cancellation, and uses transactions for replacement and deletion. For larger collections, implement the same store contract on an appropriate app index or vector database.

SQLite is loaded lazily and requires [Node 22.13 or later](https://nodejs.org/api/sqlite.html). Use a dedicated database in a private host-owned directory; POSIX mode/owner and link checks reject unsafe database or sidecar files. Windows inherits directory ACLs; the SDK does not verify those ACLs. The same trusted OS principal must own the directory and its parent chain. SQL uses static identifiers and bound values, with WAL, `synchronous=FULL`, foreign keys and secure deletion enabled. An unrelated schema or incompatible descriptor is rejected. Close the store after the host and its work stop.

The index stores passage text and vectors until explicit deletion or app-controlled lifecycle cleanup. It is not encrypted by this adapter. Secure deletion does not promise erasure from backups, snapshots or retained WAL files. Applications own encryption, retention, rebuilds and citation validity. Optional [ingestion helpers](ingestion.md) prepare PDF, Markdown and email passages. [Embedding metering](usage.md#embedding-usage) forwards separately attributed records through the existing Usagestat backend, without introducing a separate usage database.
