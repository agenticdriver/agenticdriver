# Selected context and draft artifacts

Applications can send selected text, Markdown, images and PDFs through the same local and remote run contract. The SDK preserves source identity and provenance, enforces content budgets, resolves app-authorized references on the execution host, and returns optional draft artifacts. It never resolves a caller-supplied filesystem path or fetches a source URI.

The protocol advertises `context-inputs` and `draft-artifacts`; hosts with an application resolver also advertise `context-references`. Provider catalogs expose `inputMediaTypes` per model. Text and Markdown use the existing text path. Binary formats require an explicit model entry; an undeclared format fails with `UNSUPPORTED_MODALITY` before any provider execution. There is no automatic extraction or provider/model fallback.

## Inline inputs

```ts
const result = await client.run({
  provider: "selected-provider",
  model: "selected-model",
  input: "Summarize these selected findings, citing their source IDs.",
  attachments: [
    {
      type: "text",
      mediaType: "text/markdown",
      source: {
        id: "paper-7-passage-3",
        revision: "markdown-sha256-or-app-version",
        uri: "app://library/paper-7",
        location: { documentId: "paper-7", startLine: 42, endLine: 53 },
      },
      text: "The application supplies the selected passage here.",
    },
  ],
  outputArtifact: { name: "review.md", mediaType: "text/markdown" },
});
```

`source` contains an app-issued `id`, immutable `revision`, optional title, display URI and location. IDs use ASCII letters/digits and `._:-`, start with a letter/digit and have at most 128 characters. Locations support document identity, page ranges, Markdown line ranges, section, email thread identity and message identity. URIs permit `https://` or `app://` and cannot contain credentials; they are metadata only. An app must still authorize access when following a source link.

Binary inputs replace `text` with canonical base64 `data`, use `type: "image"` or `type: "pdf"`, and declare `image/png`, `image/jpeg`, `image/webp` or `application/pdf`. The SDK checks base64 framing, decoded sizes and the format signature. This is not a complete media decoder, malware scanner or PDF/OCR parser. Applications own extraction/validation policies; malformed documents may still be rejected by the selected provider.

## Model support

Explicitly enable verified formats on the models you configure:

```ts
openai({
  id: "selected-provider",
  apiKey: () => secrets.read("openai-key"),
  models: ["selected-model"],
  inputMediaTypes: { "selected-model": ["image/png", "application/pdf"] },
});
```

The host configuration accepts the same `inputMediaTypes` mapping on API provider entries. Text-only models stay text-only even when another model on the same provider accepts images. Configuration rejects claims outside an adapter's supported formats.

| Adapter                           | Implemented binary wire mapping                                |
| --------------------------------- | -------------------------------------------------------------- |
| OpenAI Responses                  | Inline image and PDF inputs                                    |
| Anthropic Messages                | Base64 image and document blocks                               |
| Gemini GenerateContent            | Inline media parts                                             |
| xAI / compatible Chat Completions | Inline images; PDF requires explicitly supplied extracted text |
| Codex / Claude Code / Gemini CLI  | Text and Markdown context; binary inputs rejected              |

Mappings follow the provider documentation: [OpenAI images](https://developers.openai.com/api/docs/guides/images-vision), [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs), [Anthropic images](https://platform.claude.com/docs/en/build-with-claude/vision), [Anthropic PDFs](https://platform.claude.com/docs/en/build-with-claude/pdf-support), and [Gemini media parts](https://ai.google.dev/api/generate-content#Part). Native reasoning blocks and tool IDs remain intact across subsequent model steps. This implementation is fixture-tested; a model entry is an operator's explicit support declaration, not a claim that every model/account has passed live certification.

## Application references

Large documents and private corpora should use an app-owned resolver. A request carries only `{ type: "reference", id, revision, mediaType }`. The resolver receives the authenticated execution `subject`, cancellation signal, run ID and progress callback. It must authorize the exact reference and revision against that subject before returning any content.

```ts
import { AgenticDriver, MemoryContextStore } from "@agenticdriver/sdk";

const context = new MemoryContextStore({
  maxEntries: 100,
  maxBytes: 8 * 1024 * 1024,
});
const selected = context.put({
  attachment: {
    type: "text",
    mediaType: "text/markdown",
    source: {
      id: "paper-one",
      revision: "r1",
      location: { documentId: "paper-one" },
    },
    text: "Selected research context",
  },
  subjects: ["alice"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const driver = new AgenticDriver({
  providers,
  context: { resolve: context.resolve },
});
await driver.run(
  { provider, model, input: "Summarize", attachments: [selected] },
  { subject: "alice" },
);
context.delete("paper-one");
```

`MemoryContextStore` is optional ephemeral host storage. Every insertion requires explicit subjects and a future expiry. A changed payload or provenance under the same revision is rejected; assign a new revision. Replacement with a new revision invalidates old references. Deletion/revocation prevents subsequent access, and expired entries are removed by an unreferenced housekeeping timer and on access. `clear()` releases all retained entries and the timer. Default capacity is 1,000 entries / 32 MiB; limits reject new content instead of evicting live entries.

An application with existing storage can provide its own resolver:

```ts
context: {
  maxBytes: 8 * 1024 * 1024,
  resolve: async (reference, execution) => {
    const lease = await library.readAuthorized(reference, execution.subject, execution.signal);
    execution.reportProgress(); // Actual completed I/O, never a keepalive ping.
    return {
      attachment: lease.attachment,
      expiresAt: lease.expiresAt,
      release: () => lease.close(),
    };
  },
}
```

The SDK verifies that the returned ID, revision and media type match the request. It checks any declared expiry, and calls each lease's release callback once on success, failure or cancellation, including late resolver completion after cancellation. Cleanup waiting is bounded to one second; an app's callback remains responsible for actually closing its resources and reporting cleanup failures. Resolvers and tools must observe cancellation themselves.

References are reauthorized before replaying an idempotent result. Changed content under an existing revision is rejected when reconciling a completed result. This does not rerun model/tool work or emit usage a second time. Revoking content during a live run requires the application to cancel that run; already transmitted content cannot be recalled from a provider.

## Budgets and retention

| Resource                            | Limit                                                   |
| ----------------------------------- | ------------------------------------------------------- |
| Inputs per run                      | 16, with distinct source IDs                            |
| Inline decoded bytes                | 256 KiB each, 512 KiB total                             |
| All resolved/inline decoded content | 8 MiB by default; configurable up to 32 MiB             |
| Resolved/inline text                | 1,000,000 UTF-8 bytes by default; configurable downward |
| HTTP request body                   | Existing 1 MB encoded JSON limit still applies          |
| Draft artifact                      | One, up to 256 KiB of UTF-8 content                     |

The host can set `context.maxBytes` and `context.maxTextBytes` in configuration. These apply to resolver and inline content together. Resolver installation is programmatic (`configuredDriver(..., { context: { resolve } })`); remote requests cannot install one or choose its filesystem roots. References allow larger content without expanding the public request-body limit.

The driver retains resolved bytes only for the run, including its tool steps. The optional memory store uses the expiry the app supplies. Expiry/release controls future access and retained SDK references; it cannot erase app/provider copies or previously delivered results. Durable operation stores retain generated output and source manifests under the app's operation-retention policy. Input expiry does not delete that recovery log or silently evict an accepted idempotency key. Usagestat receives measurements, not input content or source metadata.

No default execution deadline or inactivity timeout is introduced. A positive `idleTimeoutMs` is optional; completed reference work and the resolver's progress callback reset that timer. Resource-cleanup waiting and content retention are separate policies.

## Sources and artifacts

`result.sources` returns the supplied source metadata plus media type, decoded byte count, SHA-256 digest, origin (`inline`/`reference`) and any reference expiry. It is a manifest of supplied evidence, not verified citations or proof that each generated claim is supported. Context is labeled as untrusted reference data and cannot grant tools or widen the app's access scope.

An optional `outputArtifact` requests `text/plain`, `text/markdown` or `application/json`. JSON artifacts also require `outputSchema` and use the validated JSON output. Results contain `{ id, name, mediaType, status: "draft", content, sha256, sourceIds }`; `sourceIds` identifies supplied evidence, not claim-level support. Names are display metadata, never SDK output paths. The SDK does not write, send or accept a canonical artifact. The app verifies grounding, handles truncated output and asks for any required user approval before saving or sending it.

Python exports context `TypedDict` types from `agenticdriver.context`; Go exposes `ContextInput`, `ContextSource`, `ContextManifest`, `ArtifactRequest` and `DraftArtifact`; Rust exposes the same types with a `ContextInput` enum. Each client sends the same JSON contract and preserves returned provenance/artifacts. `npm run test:clients` exercises actual reference, image and PDF round trips in all four languages over HTTP and certificate-verified HTTPS.

## Three application boundaries

- Brandstorm supplies selected briefs and reference images; it owns project access and approval of brand artifacts.
- LitAgent supplies selected paper/passages and immutable Markdown revisions; it resolves passage IDs to quotes, pages/lines and checks claim support. Its corpus coverage metadata and canonical library stay app-owned.
- AI Workspace supplies authorized thread/message context; it revalidates sources at display time and owns mailbox scope, draft acceptance and sending.

[Scoped retrieval](retrieval.md) adds explicit embedding/vector database ports, a persistent SQLite index and authorized evidence in all four clients. PDF/Markdown/email ingestion helpers and app-specific grounded-answer examples remain AD-047 and AD-048. A display URI does not fetch, parse or index a document.
