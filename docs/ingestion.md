# PDF, Markdown and email ingestion

`ingestContext` prepares and atomically indexes one application-owned source revision. It accepts plain text, Markdown, a PDF, a plain-text email thread, or an authorized reference to one of the first three formats. Applications keep canonical documents, revisions, permissions, jobs and accepted citations. Configure a [retrieval corpus](retrieval.md) first; ingestion uses that corpus's explicit embedding account, vector store and `index` authorization.

```ts
import { AgenticDriver } from "agenticdriver";
import { PopplerPdfExtractor } from "agenticdriver/ingestion";

const driver = new AgenticDriver({
  providers,
  retrieval,
  context: { resolve: application.resolveAuthorizedDocument },
  ingestion: {
    pdf: new PopplerPdfExtractor(), // optional; requires installed poppler-utils
    maxDocumentBytes: 8_388_608,
    maxTextBytes: 1_000_000,
    maxPages: 200,
    maxChunks: 256,
    maxChunkBytes: 2048,
  },
});

const receipt = await driver.ingestContext(
  {
    corpus: "library",
    document: {
      type: "text",
      source: {
        id: "paper-1",
        revision: "markdown-sha256-abcd",
        title: "Selected study",
      },
      mediaType: "text/markdown",
      text: "# Results\nThe measured battery lifetime was ...",
    },
  },
  { subject: "user-123" },
);

const answer = await driver.run(
  {
    provider: "generation-account",
    model: "explicit-model",
    input: "What did the study report about battery lifetime?",
    retrieval: { corpus: "library", sourceIds: [receipt.sourceId] },
  },
  { subject: "user-123" },
);
```

`prepareDocument(request, ingestionOptions, contextOptions, executionContext)` is an exported host helper for inspecting the prepared chunks before calling `indexContext`. It does not grant index access. Applications with existing passage IDs can continue to use prepared indexing directly.

## Formats and provenance

- **Markdown:** ATX and setext headings outside fenced code define conservative section boundaries. Chunks retain section titles and one-based source line ranges. This is a text chunker, not a full CommonMark renderer; links, HTML and code never execute.
- **Plain text:** chunks retain line ranges. CRLF/CR becomes LF for indexing, while the input digest identifies the original bytes. Whole lines stay together when possible. Oversized lines split at UTF-8 boundaries; several chunks can share a line range, so applications still validate the exact quoted span.
- **Email:** provide `{type: "email", source, threadId, messages: [{id, text}]}`. Chunks never cross a message and retain `threadId`, `messageId` and message-local line ranges. The application supplies plain-text bodies; the SDK does not fetch mail, parse MIME, strip HTML or load attachments. The input digest covers the ordered thread/message representation. Empty messages are counted explicitly.
- **PDF:** provide `{type: "pdf", source, mediaType: "application/pdf", data: base64}` or an authorized PDF reference. An explicitly configured extractor returns every page in order. Chunks never cross pages, and retain page numbers and extracted-text line ranges. A source's starting page/line offsets are preserved for selected excerpts. PDF line ranges describe extracted text, not visual coordinates or bounding boxes.

Generated chunk IDs are deterministic hashes of the source ID, location, text and passage ordinal. Search results retain the original document ID/revision. Run citation IDs identify chunks, while `location.documentId` identifies the application document. Applications validate quote spans, current access, current source revisions and navigation targets when displaying saved evidence.

Each receipt and retrieved hit includes an `ingestion` manifest: original input SHA-256 and byte count, format, extractor identity/version, chunker identity and byte limit, extracted/indexed text byte counts and chunk count. PDFs include total pages, OCR-attempted pages and remaining empty pages. Email manifests include total and empty message counts. This records extraction provenance; it is not an assertion that every visual element, image, table, or claim has been extracted or verified.

## PDF extraction and explicit OCR

`PopplerPdfExtractor` calls the installed `pdfinfo` and `pdftotext` executables with a private temporary PDF, a minimal environment and no shell. Optional executable paths belong to host configuration, never the request. Temporary files are removed after completion or cancellation. The adapter uses Poppler's [page/encryption metadata](https://manpages.debian.org/testing/poppler-utils/pdfinfo.1.en.html) and [layout-preserving UTF-8 text output](https://manpages.debian.org/testing/poppler-utils/pdftotext.1.en.html), verifies page boundaries and records the actual Poppler version.

The adapter is optional. Without an extractor, PDFs fail with `PDF_EXTRACTOR_REQUIRED`. A missing executable yields `PDF_EXTRACTOR_UNAVAILABLE`. Malformed, encrypted, permission-denied and over-limit inputs fail before indexing. Encrypted PDFs require an explicitly configured application extractor. Native parser CPU and memory are not OS-sandboxed by the SDK; process isolation/resource policy belongs to the execution host.

Pages with no extractable text fail with `OCR_REQUIRED` by default. To process scanned pages, supply `ingestion.ocr: PdfOcrAdapter`. It receives the original PDF, the exact empty page numbers, page/text limits and a cancellable execution context. It must return those pages in order and its extractor identity/version. No OCR service, account or credential is inferred. There is no bundled OCR engine. Mixed pages containing both digital text and images are not automatically OCRed, so applications needing complete visual extraction should supply their own `PdfExtractor`.

If OCR still leaves empty pages, ingestion fails with `EMPTY_EXTRACTION`. Applications can explicitly set `allowEmptyPdfPages: true` to permit partial text coverage; every omitted page remains listed in the manifest. An entirely empty document always fails. An app should display or enforce its coverage policy before accepting evidence.

## Revisions, permissions and failure handling

Ingestion authorizes the exact source ID/revision before resolving a reference or invoking a parser, then rechecks authorization before embedding and replacement. References use the existing context resolver and release their leases on success, failure or cancellation. The app controls which index revisions remain authorized; a context read lease is not an index-retention policy.

All chunks and embedding batches must succeed before one atomic source replacement. Identical content, provenance and revision returns `unchanged` without another embedding call. Preparation can still run to verify the input; this is not a parser cache. Changed input bytes, extraction version or chunking under the same immutable revision yields `SOURCE_CONFLICT`. Rebuild with an app-managed revision/corpus version when changing the extraction pipeline. Failed extraction, cancellation, malformed vectors or failed batches never leave a partial document. Existing exact-revision search and deletion rules exclude stale, revoked and deleted sources.

There is no default execution deadline or inactivity timeout. An explicit positive `idleTimeoutMs` resets on real extraction, chunking, embedding, authorization or store progress. A host inactivity policy can impose a smaller limit. No heartbeat resets that clock, and zero/omitted values do not disable a configured host limit. TypeScript/Go also accept cancellation signals/contexts. Python/Rust use their blocking transport model. A custom extractor must honor the execution context's signal and report actual progress.

## Bounds and remote access

| Bound                         | Default | Maximum |
| ----------------------------- | ------- | ------- |
| Original document bytes       | 8 MiB   | 32 MiB  |
| Extracted text bytes          | 1 MiB   | 1 MiB   |
| Pages                         | 200     | 1,000   |
| Email messages                | 1,000   | 1,000   |
| Chunks per source             | 256     | 256     |
| Text per chunk                | 2 KiB   | 16 KiB  |
| Texts per embedding call      | 32      | 256     |
| Text bytes per embedding call | 64 KiB  | 1 MiB   |

Host options may lower these limits. `chunking.maxBytes` in a request can only lower the host's chunk size and must be at least 128 bytes. Provider token limits also apply; there is no inferred tokenizer or silent provider-input truncation. Existing context limits apply while loading text/PDF attachments; inline/reference text is additionally limited to 1,000,000 bytes. The HTTP JSON body limit is 1,000,000 bytes including base64/metadata. Use an authorized application reference for larger PDFs; a reference never instructs the SDK to read an arbitrary path or URL.

`POST /v1/retrieval/ingest` shares authenticated TLS transport, origin checks, concurrency bounds and disconnect cancellation with retrieval. It requires the token's `retrieval.index: [corpus]` grant plus application index permission. `document-ingestion` is advertised only when retrieval is configured; `pdf-ingestion` additionally requires an explicit PDF extractor. `configuredDriver` accepts programmatic `retrieval` and `ingestion` options. An ordinary host JSON file cannot supply application permissions or a parser callback.

All four clients validate the manifest and receipt identity and preserve provenance on retrieved evidence:

```python
receipt = client.ingest_context({
    "corpus": "mail",
    "document": {
        "type": "email", "source": {"id": "thread-1", "revision": "r1"},
        "threadId": "thread-1", "messages": [{"id": "message-1", "text": "The meeting is Friday."}]
    }
})
```

```go
receipt, err := client.IngestContext(ctx, agenticdriver.IngestRequest{
    Corpus: "library",
    Document: agenticdriver.IngestionDocument{
        Type: "reference", ID: "paper-1", Revision: "r1", MediaType: "application/pdf",
    },
})
```

```rust
let receipt = client.ingest_context(&agenticdriver::IngestRequest {
    corpus: "library".into(),
    document: agenticdriver::IngestionDocument::Reference {
        id: "paper-1".into(), revision: "r1".into(), media_type: "application/pdf".into(),
    },
    chunking: None, idle_timeout_ms: None,
})?;
```

Embedding usage is separately attributed to its configured provider/account and forwarded through the existing [Usagestat dependency](usage.md#embedding-usage). It does not inflate generation token totals. Fixture embeddings and fixture PDF/OCR adapters remain test fixtures; the Poppler integration has a separate test using actual digital PDFs.
