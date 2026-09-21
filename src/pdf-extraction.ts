import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriverError } from "./errors.js";
import { runProcess } from "./providers/local-cli.js";
import type { ExecutionContext } from "./types.js";

export interface ExtractionIdentity {
  id: string;
  version: string;
}
export interface PdfPage {
  page: number;
  text: string;
}
export interface PdfExtraction {
  pages: PdfPage[];
  extractor: ExtractionIdentity;
}
export interface PdfExtractionLimits {
  maxPages: number;
  maxTextBytes: number;
}
export interface PdfExtractor {
  /** Return every page in order, including empty pages. Page numbers start at one. */
  extract(
    pdf: Uint8Array,
    limits: PdfExtractionLimits,
    context: ExecutionContext,
  ): Promise<PdfExtraction>;
}
export interface PdfOcrAdapter {
  /** Only explicitly selected empty pages. No automatic OCR service or credentials are inferred. */
  extract(
    pdf: Uint8Array,
    pages: readonly number[],
    limits: PdfExtractionLimits,
    context: ExecutionContext,
  ): Promise<PdfExtraction>;
}
export interface PopplerOptions {
  /** Host configuration only; either an installed command name or an absolute executable path. */
  pdfinfo?: string;
  pdftotext?: string;
}

/** Optional native Poppler adapter. Install poppler-utils separately or supply an application extractor. */
export class PopplerPdfExtractor implements PdfExtractor {
  private readonly options: Required<PopplerOptions>;
  constructor(options: PopplerOptions = {}) {
    this.options = {
      pdfinfo: options.pdfinfo ?? "pdfinfo",
      pdftotext: options.pdftotext ?? "pdftotext",
    };
    if (
      Object.values(this.options).some(
        (binary) => !binary || binary.includes("\0"),
      )
    )
      throw new Error(
        "PDF extractor executable names must be nonempty and contain no NUL.",
      );
  }
  async extract(
    pdf: Uint8Array,
    limits: PdfExtractionLimits,
    context: ExecutionContext,
  ): Promise<PdfExtraction> {
    context.signal.throwIfAborted();
    if (
      !pdf.length ||
      pdf.length > 33_554_432 ||
      !Buffer.from(pdf.subarray(0, 5)).equals(Buffer.from("%PDF-"))
    )
      throw new DriverError(
        "INVALID_DOCUMENT",
        "PDF input must have a PDF signature and fit the document byte limit.",
      );
    if (
      !Number.isSafeInteger(limits.maxPages) ||
      limits.maxPages < 1 ||
      limits.maxPages > 1000 ||
      !Number.isSafeInteger(limits.maxTextBytes) ||
      limits.maxTextBytes < 1 ||
      limits.maxTextBytes > 1_048_576
    )
      throw new DriverError(
        "INVALID_INGESTION_POLICY",
        "PDF extraction limits must bound pages and text bytes.",
      );
    const directory = await mkdtemp(join(tmpdir(), "agenticdriver-pdf-")),
      path = join(directory, "source.pdf");
    try {
      await writeFile(path, pdf, { mode: 0o600, signal: context.signal });
      const info = await this.command(
        this.options.pdfinfo,
        ["-enc", "UTF-8", path],
        directory,
        context,
      );
      const pages = Number(
        [...info.matchAll(/^Pages:\s+(\d+)\s*$/gm)].at(-1)?.[1],
      );
      const encrypted = [...info.matchAll(/^Encrypted:\s+(yes|no)\b/gm)].at(
        -1,
      )?.[1];
      if (encrypted === "yes")
        throw new DriverError(
          "PDF_ENCRYPTED",
          "Encrypted PDFs require an explicitly configured application extractor.",
        );
      if (!Number.isSafeInteger(pages) || pages < 1)
        throw new DriverError(
          "INVALID_DOCUMENT",
          "The PDF parser did not report a valid page count.",
        );
      if (pages > limits.maxPages)
        throw new DriverError(
          "DOCUMENT_LIMIT",
          "The PDF exceeds the host's page limit.",
        );
      const versionText = await this.command(
        this.options.pdftotext,
        ["-v"],
        directory,
        context,
        true,
      );
      const version = /^pdftotext version ([a-zA-Z0-9._+-]{1,80})/m.exec(
        versionText,
      )?.[1];
      if (!version)
        throw new DriverError(
          "PDF_EXTRACTOR_UNAVAILABLE",
          "The configured text extractor did not identify a supported Poppler executable.",
        );
      const output = await this.command(
        this.options.pdftotext,
        ["-layout", "-enc", "UTF-8", "-eol", "unix", path, "-"],
        directory,
        context,
      );
      if (Buffer.byteLength(output) > limits.maxTextBytes + pages)
        throw new DriverError(
          "DOCUMENT_LIMIT",
          "PDF extraction exceeded the host's text byte limit.",
        );
      const texts = output.split("\f");
      if (texts.at(-1)?.trim() === "") texts.pop();
      if (texts.length !== pages)
        throw new DriverError(
          "INVALID_EXTRACTION",
          "PDF page boundaries did not match the reported page count.",
        );
      context.signal.throwIfAborted();
      return {
        pages: texts.map((text, index) => ({ page: index + 1, text })),
        extractor: { id: "poppler-layout", version },
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async command(
    binary: string,
    args: string[],
    cwd: string,
    context: ExecutionContext,
    includeStderr = false,
  ): Promise<string> {
    let exitCode: number | null = null;
    try {
      // No model credentials, user shell, account directory or implicit remote resource fetch.
      const result = await runProcess(binary, args, {
        cwd,
        signal: context.signal,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          LANG: "C.UTF-8",
          LC_ALL: "C",
        },
        includeStderr,
        acceptedExitCodes: [0, 1, 2, 3, 99],
        onExit: (code) => {
          exitCode = code;
        },
        onLine: () => context.reportProgress(),
      });
      if (exitCode === 3)
        throw new DriverError(
          "PDF_PERMISSIONS",
          "The PDF parser could not read this document with its current permissions.",
        );
      if (exitCode !== 0)
        throw new DriverError(
          "INVALID_DOCUMENT",
          "The PDF parser could not extract this document.",
        );
      return result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (error instanceof DriverError) {
        if (error.code === "CLI_UNAVAILABLE")
          throw new DriverError(
            "PDF_EXTRACTOR_UNAVAILABLE",
            "Install the configured Poppler executables or supply an application PDF extractor.",
          );
        if (error.code === "CLI_OUTPUT_LIMIT")
          throw new DriverError(
            "DOCUMENT_LIMIT",
            "The PDF parser exceeded its output limit.",
          );
        if (error.code.startsWith("PDF_") || error.code === "INVALID_DOCUMENT")
          throw error;
      }
      throw new DriverError(
        "PDF_EXTRACTION_FAILED",
        "PDF extraction failed. Inspect the host's private diagnostics.",
      );
    }
  }
}
