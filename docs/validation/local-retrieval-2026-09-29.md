# Real local embeddings and remote retrieval — 2026-09-29

This is development qualification for [#72](https://github.com/agenticdriver/agenticdriver/issues/72),
before the final RC artifact. It uses actual learned embeddings and native
subscription accounts. No provider substitute, fixed vector, canned model
response, private library or private mailbox was used.

## Model and documents

The optional runtime is Transformers.js `4.3.0`, with CPU ONNX inference using
`Xenova/all-MiniLM-L6-v2`, revision
`751bff37182d3f1213fa05d7196b954e230abad9`, q8, mean pooling, 384 dimensions and
a 256-token input bound. Authentication is `none`; `rc-local-embeddings` is a
local deployment identity, not an invented provider login. Real token counts
use `adapter-report` through the existing usage-envelope contract. No API bill
is inferred from local computation.

- The complete 19-page [Lewis et al. RAG paper](https://arxiv.org/pdf/2005.11401v4)
  was extracted by installed Poppler, with no omitted or OCR pages, into 191
  passages. The original PDF SHA-256 is recorded in the JSON receipt.
- Repository release-gate Markdown yielded eight passages with section/line
  provenance. A realistic two-message release-handoff thread yielded two
  passages retaining the thread and message identities.
- Prepared documents used a maximum of 512 UTF-8 bytes per passage. Model input
  limits were enforced by the actual tokenizer rather than an estimated count.

The complete local sequence passed semantic similarity against an unrelated
passage, cancellation and subsequent execution, rejection of oversized token
input, missing pinned-model rejection, unchanged-document indexing without
another embedding call, namespace/selected-source isolation, immutable
revisions, stale-evidence rejection, explicit reindexing, deletion and
incompatible-index rejection. Closing/reopening SQLite returned identical
evidence. A separate real check filled the four-call queue, rejected a fifth,
cancelled a queued call and completed the remaining work. Explicit preparation
in a fresh cache downloaded the pinned real model successfully. Normal calls
used offline loading.

## Remote protocol and generation

A separate Node `24.16.0` host on Prometheus indexed the prepared passages using
the same real local model. The original PDF extraction ran on the application
computer; remote calls indexed its actual prepared chunks. The host bound only
loopback `17437`, reached through verified OpenSSH. It used its own connection
store, database, grants and usage files. Other application/validation hosts and
native account profiles were preserved. The reviewed six-hour grant covered
only the two selected native providers and the `release-library` corpus's
search/index/delete operations; it granted no tools, management or jobs.

TypeScript, Python, Go and Rust clients independently returned identical four-hit
search results, including model identity, original source revision, page/line
locations, ingestion manifest and passage digest. TypeScript used the recorded
development archive; Python used a freshly installed wheel; Go used published
alpha.6; Rust used development source after adding serialization for its typed
retrieval results. This discovered and fixed the missing Rust `Serialize`
implementation. These are protocol checks, not a claim that final RC client
artifacts have already been published or accepted. Restarting the real remote
host preserved the same scoped connection and exact SQLite search results.

Generation explicitly selected the already signed-in Codex CLI `0.157.0`,
`gpt-6-luna`, medium reasoning, and Claude Code `2.1.282`,
`claude-haiku-4-5-20251001`. Both reported Pro subscriptions. Catalog refresh
reported nine Codex and fourteen Claude entries; only the selected models ran.

| Run                                    | Outcome                                                             | Input / output tokens |
| -------------------------------------- | ------------------------------------------------------------------- | --------------------: |
| `45bda284-56c6-4d5a-ba40-aecc1307b47b` | Codex paper answer completed; rejected for mistyped source IDs      |           7,868 / 189 |
| `12a2607b-61c9-4b08-a649-169cd4244eff` | Codex paper answer with a focused retrieval query; exact IDs passed |           7,289 / 186 |
| `a9dd648d-9803-4ff5-b6a6-ac629bc70d64` | Claude release-handoff draft; exact IDs passed                      |         4,200 / 2,648 |

The first failure is retained. A separate request supplied the actual paper
question as the retrieval query, keeping writing instructions out of similarity
search; it did not switch account, model or billing mode. No automatic generation
retry ran. The final paper answer distinguishes document-level versus token-level
marginalization and labels its attribution implication as an inference. The
email draft retains pending PyPI approval and no-private-mail/no-send commitments.
Both remained drafts; no application acceptance or external email was performed.

The SDK now exposes opt-in exact citation-ID validation in all four languages.
Rechecking the original real responses accepted Claude's IDs and rejected
Codex's typo with `INVALID_CITATION`, without another model call. This verifies
reference identity, not factual support. Applications still review claims and
quotes and recheck current source permissions before accepting an artifact.

Codex's second run reported 4,864 cached input tokens. Claude's reported
USD 0.02163 API-equivalent amount is not an actual subscription charge. Reported
output usage need not equal visible answer length. No default deadline,
inactivity timeout or provider fallback was introduced.

## Evidence and limits

The [sanitized JSON receipt](local-retrieval-2026-09-29.json) records prompts,
model/index identities, run IDs, counts and checksums. Full responses, retrieved
paper passages, prepared chunks and private profiles remain in private local
validation state. Source/batch limits are bounded exact cosine search, not a
large-corpus ANN performance claim. Only this English model and Linux route are
qualified here; other models/platforms and OCR need their own checks.

Local typechecking, 27 pure SDK tests, installed Python/Rust/Go contract checks,
fresh npm installation without the optional model runtime, and the documentation
build passed separately. Integrated security review and final RC artifact/app
acceptance remain [release gates](../release-candidate.md).

The implementation commit `a8c53a6a23e3d961aa9659d9ac7c51f795f1b34d` passed all
seven checks in [Prometheus run 36562335687, attempt 2](https://github.com/agenticdriver/agenticdriver/actions/runs/36562335687).
The first attempt stopped four jobs at the private disk-space guard; SDK-owned
retired temporary archives and unused CI images were cleaned before rerunning.
Successful jobs were retained, failed jobs reran successfully. No credentials or
model requests were added to CI. Final RC artifact acceptance remains #71.
