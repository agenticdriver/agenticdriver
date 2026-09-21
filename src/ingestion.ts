import { createHash } from "node:crypto";
import { abortable, DriverError } from "./errors.js";
import {
  contextPolicy,
  resolveContext,
  type ContextOptions,
} from "./context.js";
import {
  chunkSegments,
  markdownSegments,
  type TextSegment,
} from "./chunking.js";
import {
  IngestRequestSchema,
  IngestResultSchema,
  IngestionManifestSchema,
  type IngestRequest,
  type IngestResult,
  type IngestionManifest,
} from "./ingestion-types.js";
import type {
  PdfExtractor,
  PdfOcrAdapter,
  PdfExtraction,
  ExtractionIdentity,
} from "./pdf-extraction.js";
import type { RetrievalService } from "./retrieval.js";
import type { RetrievalIndexRequest } from "./retrieval-types.js";
import type { ContextSource } from "./context-types.js";
import type { ExecutionContext } from "./types.js";

export interface IngestionOptions {
  pdf?: PdfExtractor;
  ocr?: PdfOcrAdapter;
  /** Explicit policy for intentionally blank/unextractable pages. Manifest records all omissions. */
  allowEmptyPdfPages?: boolean;
  maxDocumentBytes?: number;
  maxTextBytes?: number;
  maxPages?: number;
  maxMessages?: number;
  maxChunks?: number;
  maxChunkBytes?: number;
}
export function ingestionPolicy(input: IngestionOptions = {}) {
  const limits = {
    maxDocumentBytes: input.maxDocumentBytes ?? 8_388_608,
    maxTextBytes: input.maxTextBytes ?? 1_048_576,
    maxPages: input.maxPages ?? 200,
    maxMessages: input.maxMessages ?? 1000,
    maxChunks: input.maxChunks ?? 256,
    maxChunkBytes: input.maxChunkBytes ?? 2048,
  };
  const maximum = {
    maxDocumentBytes: 33_554_432,
    maxTextBytes: 1_048_576,
    maxPages: 1000,
    maxMessages: 1000,
    maxChunks: 256,
    maxChunkBytes: 16_384,
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < (key === "maxChunkBytes" ? 128 : 1) ||
      limits[key] > maximum[key]
    )
      throw new DriverError(
        "INVALID_INGESTION_POLICY",
        "Ingestion limits must be positive integers within the supported document, text, page, message and chunk bounds.",
      );
  return {
    ...limits,
    pdf: input.pdf,
    ocr: input.ocr,
    allowEmptyPdfPages: input.allowEmptyPdfPages ?? false,
  };
}

/** Prepare and atomically index one complete app-owned source revision. No paths, commands or URLs are loaded from request text. */
export async function ingestDocument(
  input: IngestRequest,
  retrieval: RetrievalService,
  options: IngestionOptions,
  contextOptions: ContextOptions,
  context: ExecutionContext,
): Promise<IngestResult> {
  const request = parseRequest(input);
  const document = request.document;
  await retrieval.authorizeIndex(
    request.corpus,
    document.type === "reference" ? document : document.source,
    context,
  );
  const prepared = await prepareDocument(
    request,
    options,
    contextOptions,
    context,
  );
  const indexed = await retrieval.index(prepared, context);
  return IngestResultSchema.parse({
    ...indexed,
    ingestion: prepared.ingestion,
  });
}

/** Host-side preparation for apps that need to review chunks before indexing. This helper alone grants no source/index access. */
export async function prepareDocument(
  input: IngestRequest,
  options: IngestionOptions,
  contextOptions: ContextOptions,
  context: ExecutionContext,
): Promise<RetrievalIndexRequest & { ingestion: IngestionManifest }> {
  const request = parseRequest(input),
    policy = ingestionPolicy(options),
    document = request.document;
  const maxBytes = Math.min(
    request.chunking?.maxBytes ?? policy.maxChunkBytes,
    policy.maxChunkBytes,
  );
  let source: ContextSource,
    raw: Buffer,
    segments: TextSegment[],
    format: IngestionManifest["format"],
    extractor: ExtractionIdentity = { id: "plain-text", version: "1" },
    ocrExtractor: ExtractionIdentity | undefined,
    pages: IngestionManifest["pages"],
    messages: IngestionManifest["messages"];
  let release: (() => Promise<void>) | undefined;
  try {
    context.signal.throwIfAborted();
    if (document.type === "email") {
      if (document.messages.length > policy.maxMessages)
        limit("The thread exceeds the host's message limit.");
      let bytes = 0;
      for (const message of document.messages) {
        bytes += Buffer.byteLength(message.text);
        if (bytes > policy.maxTextBytes)
          limit("The thread exceeds the host's extracted text limit.");
      }
      raw = Buffer.from(
        JSON.stringify({
          threadId: document.threadId,
          messages: document.messages,
        }),
      );
      source = document.source;
      format = "email";
      extractor = { id: "email-plain-text", version: "1" };
      segments = document.messages.map((message) => ({
        text: normalizeText(message.text),
        location: { threadId: document.threadId, messageId: message.id },
      }));
      messages = {
        total: document.messages.length,
        empty: segments.filter((segment) => !segment.text.trim()).length,
      };
    } else {
      const inherited = contextPolicy(contextOptions);
      const resolved = await resolveContext(
        [document],
        {
          ...contextOptions,
          maxBytes: Math.min(inherited.maxBytes, policy.maxDocumentBytes),
          maxTextBytes: Math.min(inherited.maxTextBytes, policy.maxTextBytes),
        },
        context,
      );
      release = resolved.release;
      const attachment = resolved.attachments[0]!;
      source = attachment.source;
      if (attachment.type === "text") {
        raw = Buffer.from(attachment.text);
        const text = normalizeText(attachment.text);
        format = attachment.mediaType === "text/markdown" ? "markdown" : "text";
        extractor = {
          id: format === "markdown" ? "markdown-sections" : "plain-text",
          version: "1",
        };
        segments = format === "markdown" ? markdownSegments(text) : [{ text }];
        segments = segments.map((segment) => ({
          ...segment,
          startLine:
            (segment.startLine ?? 1) + (source.location?.startLine ?? 1) - 1,
        }));
      } else if (attachment.type === "pdf") {
        raw = Buffer.from(attachment.data, "base64");
        format = "pdf";
        if (!policy.pdf)
          throw new DriverError(
            "PDF_EXTRACTOR_REQUIRED",
            "Configure an explicit PDF extractor on the execution host before ingesting PDFs.",
          );
        const limits = {
          maxPages: policy.maxPages,
          maxTextBytes: policy.maxTextBytes,
        };
        const extracted = await abortable(
          policy.pdf.extract(raw, limits, context),
          context.signal,
        );
        validateExtraction(extracted, limits.maxPages, limits.maxTextBytes);
        let extractedPages = extracted.pages.map((page) => ({
          page: page.page,
          text: normalizeText(page.text),
        }));
        extractor = extracted.extractor;
        const empty = extractedPages
          .filter((page) => !page.text.trim())
          .map((page) => page.page);
        let usedOcr: number[] = [];
        if (empty.length && policy.ocr) {
          const recognized = await abortable(
            policy.ocr.extract(raw, empty, limits, context),
            context.signal,
          );
          validateExtraction(
            recognized,
            limits.maxPages,
            limits.maxTextBytes,
            empty,
          );
          const byPage = new Map(
            recognized.pages.map((page) => [
              page.page,
              normalizeText(page.text),
            ]),
          );
          extractedPages = extractedPages.map((page) => ({
            ...page,
            text: byPage.get(page.page) ?? page.text,
          }));
          ocrExtractor = recognized.extractor;
          usedOcr = empty;
        } else if (empty.length && !policy.allowEmptyPdfPages)
          throw new DriverError(
            "OCR_REQUIRED",
            "PDF pages contain no extractable text. Configure an OCR adapter, or explicitly allow and disclose empty pages.",
          );
        const remaining = extractedPages
          .filter((page) => !page.text.trim())
          .map((page) => page.page);
        if (remaining.length && !policy.allowEmptyPdfPages)
          throw new DriverError(
            "EMPTY_EXTRACTION",
            "Configured OCR did not produce text for every selected page. No partial index was written.",
          );
        pages = {
          total: extractedPages.length,
          ocr: usedOcr,
          empty: remaining,
        };
        segments = extractedPages.map((page) => ({
          text: page.text,
          location: {
            page: page.page + (source.location?.page ?? 1) - 1,
            pageEnd: page.page + (source.location?.page ?? 1) - 1,
          },
        }));
      } else
        throw new DriverError(
          "UNSUPPORTED_INGESTION",
          "Ingestion supports text, Markdown, PDF and plain-text email documents.",
        );
    }
    if (raw.byteLength > policy.maxDocumentBytes)
      limit("The source exceeds the host's document byte limit.");
    const extractedTextBytes = segments.reduce(
      (sum, segment) => sum + Buffer.byteLength(segment.text),
      0,
    );
    if (extractedTextBytes > policy.maxTextBytes)
      limit("Extraction exceeded the host's text byte limit.");
    const chunks = await chunkSegments(
      source,
      segments,
      maxBytes,
      policy.maxChunks,
      context,
    );
    if (!chunks.length)
      throw new DriverError(
        "EMPTY_DOCUMENT",
        "The selected source contains no nonempty passages to index.",
      );
    const ingestion: IngestionManifest = {
      format,
      inputSha256: createHash("sha256").update(raw).digest("hex"),
      inputBytes: raw.byteLength,
      extractor,
      ...(ocrExtractor ? { ocrExtractor } : {}),
      chunker: { id: "source-lines-v1", maxBytes },
      extractedTextBytes,
      indexedTextBytes: chunks.reduce(
        (sum, chunk) => sum + Buffer.byteLength(chunk.text),
        0,
      ),
      chunks: chunks.length,
      ...(pages ? { pages } : {}),
      ...(messages ? { messages } : {}),
    };
    context.signal.throwIfAborted();
    return { corpus: request.corpus, source, chunks, ingestion };
  } finally {
    await release?.();
  }
}

function parseRequest(input: unknown): IngestRequest {
  const parsed = IngestRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_INGESTION",
      "The ingestion request does not match the supported document schema.",
    );
  return parsed.data;
}
function normalizeText(text: string): string {
  if (
    typeof text !== "string" ||
    text.includes("\0") ||
    Buffer.from(text).toString("utf8") !== text
  )
    throw new DriverError(
      "INVALID_DOCUMENT",
      "Document text must be valid UTF-8 without NUL characters.",
    );
  return text.replace(/\r\n?/g, "\n");
}
function limit(message: string): never {
  throw new DriverError("DOCUMENT_LIMIT", message);
}
function validateExtraction(
  result: PdfExtraction,
  maxPages: number,
  maxTextBytes: number,
  selected?: number[],
): void {
  if (
    !result ||
    !Array.isArray(result.pages) ||
    !result.pages.length ||
    result.pages.length > maxPages ||
    (selected && result.pages.length !== selected.length) ||
    result.pages.some(
      (page, i) =>
        !page ||
        page.page !== (selected?.[i] ?? i + 1) ||
        typeof page.text !== "string",
    ) ||
    !IngestionManifestSchema.shape.extractor.safeParse(result.extractor).success
  )
    throw new DriverError(
      "INVALID_EXTRACTION",
      "The PDF extractor must return all requested pages in order with its identity.",
    );
  if (
    result.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0) >
    maxTextBytes
  )
    limit("The PDF extractor exceeded the host's text byte limit.");
}

export * from "./ingestion-types.js";
export { PopplerPdfExtractor } from "./pdf-extraction.js";
export type {
  PdfExtractor,
  PdfOcrAdapter,
  PdfPage,
  PdfExtraction,
  PdfExtractionLimits,
  ExtractionIdentity,
  PopplerOptions,
} from "./pdf-extraction.js";
