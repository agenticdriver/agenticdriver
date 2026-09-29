# Local CPU embeddings

`LocalEmbeddingAdapter` runs a real trained ONNX model on the execution host.
It is an optional alternative to an explicitly configured embedding API account.
Generation continues to use the separately selected native subscription or API
provider. It never falls back between the two.

Install the optional runtime **on the Node execution host**, alongside the SDK:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm install --save-exact @huggingface/transformers@4.3.0
```

The SDK's ordinary client install does not install this runtime or model weights.
On the qualified Linux x64 route, `ONNXRUNTIME_NODE_INSTALL=skip` uses ONNX's
bundled CPU runtime without downloading optional GPU libraries.
Python, Go and Rust use the same retrieval HTTP methods; they do not need ONNX,
Node or a model cache on the application computer.

```ts
import { LocalEmbeddingAdapter } from "@agenticdriver/sdk/retrieval";

const embedding = new LocalEmbeddingAdapter({
  providerId: "local-cpu",
  accountId: "library-index", // Explicit local deployment label, not a login.
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dimensions: 384,
  cacheDirectory: "/private/agenticdriver/model-cache",
  dtype: "q8",
  pooling: "mean",
  maxTokens: 256,
  allowDownload: false,
});
```

Supply this adapter to an app-authorized [retrieval corpus](retrieval.md) with
`SqliteVectorStore`. Application authorization, document revisions, corpus grants
and canonical storage remain the application's responsibility.

The [selected model](https://huggingface.co/Xenova/all-MiniLM-L6-v2) is an
Apache-2.0 ONNX conversion of
[all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
It is a small English sentence/passage model, not a claim that every embedding
model or language is qualified. Evaluate retrieval relevance for your documents.

## Prepare the explicit model

Create a private cache directory owned by the host user. During an intentional
preparation step, construct the same adapter with `allowDownload: true` and call
`embed` with a permitted real passage, for example a paragraph from your public
release notes. That step downloads the selected revision's tokenizer, config
and quantized ONNX weights from Hugging Face using its pinned runtime. The
default is false; request text cannot turn downloads on. No Hugging Face token
or provider credential is passed to the worker.

Then use `allowDownload: false` for normal operation. Offline loading addresses
only `<cacheDirectory>/<model>/<revision>` and disables remote model access.
Missing files fail with `EMBEDDING_MODEL_UNAVAILABLE`. No model is chosen or
downloaded as a fallback. The cache and its parent chain must remain under the
trusted host owner's control; do not load an untrusted model or replace its
files after preparation. An immutable upstream revision identifies the intended
weights; it is not local tamper protection.

The adapter supports only the explicitly installed runtime version `4.3.0`.
Configuration of its loading and cache behavior follows the runtime's
[environment API](https://huggingface.co/docs/transformers.js/api/env).
Changing the model revision, precision or pooling changes the embedding identity;
the SQLite corpus rejects incompatible vectors and requires an explicit rebuild.

## Bounds, cancellation and usage

Each adapter serializes inference with at most four active/queued calls. Every
batch owns a worker, and cancellation terminates it before releasing the queue.
No default deadline or inactivity timeout is added. File loading and completed
embeddings report actual progress. Workers use one ONNX inference thread and a
128 MiB JavaScript heap limit. Native ONNX allocations are outside that heap
limit: use deployment memory/process limits for a hard resource boundary. A
worker thread is not an OS security sandbox.

All text is tokenized before batch inference. Inputs exceeding `maxTokens` are
rejected, never silently truncated. Use suitable ingestion chunk sizes; the
qualification uses 512 UTF-8 bytes per chunk and a 256-token limit. Other text
may tokenize differently and require smaller chunks. Existing byte, batch and
vector-dimension limits still apply.

`inputTokens` is the sum reported by the actual tokenizer, including its special
tokens, attributed as `adapter-report` with authentication mode `none`. It is
local computation, not a paid provider response or an invented billing amount.
Forward it through the existing [embedding usage sink](usage.md#embedding-usage).
Raw runtime diagnostics and passage text are not exposed in public errors.

## Reproduce real qualification

From a disposable built source checkout, explicitly install the runtime as a
development dependency (`npm install --save-dev --save-exact --ignore-scripts
@huggingface/transformers@4.3.0`) and prepare the model. Normal SDK CI does not
install the optional runtime, download models or replace inference with a
simulated service. Then run:

```sh
node scripts/qualify-local-retrieval.mjs \
  --cache /private/model-cache \
  --pdf /private/2005.11401v4.pdf \
  --state /private/retrieval-qualification \
  --receipt /private/retrieval-receipt.json
```

Use the original [Lewis et al. PDF](https://arxiv.org/pdf/2005.11401v4); the script
checks its SHA-256 before indexing. Install Poppler's `pdfinfo` and `pdftotext`
for PDF extraction. The run indexes the full paper, this repository's release
gate Markdown and a realistic release-handoff email thread. It checks actual
semantic vectors, cancellation, oversized inputs, revision identity, scoped
retrieval, persistence, updates and deletion. The private receipt contains
retrieved paper passages and prepared chunks. Do not publish it unreviewed.
This script does not make a generation request or claim application acceptance.
