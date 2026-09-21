import { z } from "zod";
import { ContextSourceSchema } from "./context-types.js";

const count = z.number().int().min(0).max(1_048_576);
const page = z.number().int().min(1).max(1000);
export const IngestionManifestSchema = z
  .object({
    format: z.enum(["text", "markdown", "pdf", "email"]),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputBytes: z.number().int().min(1).max(33_554_432),
    extractor: z
      .object({
        id: ContextSourceSchema.shape.id,
        version: z.string().min(1).max(128),
      })
      .strict(),
    ocrExtractor: z
      .object({
        id: ContextSourceSchema.shape.id,
        version: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    chunker: z
      .object({
        id: z.literal("source-lines-v1"),
        maxBytes: z.number().int().min(128).max(16_384),
      })
      .strict(),
    extractedTextBytes: count,
    indexedTextBytes: count,
    chunks: z.number().int().min(1).max(256),
    pages: z
      .object({
        total: page,
        ocr: z.array(page).max(1000),
        empty: z.array(page).max(1000),
      })
      .strict()
      .optional(),
    messages: z
      .object({
        total: z.number().int().min(1).max(1000),
        empty: z.number().int().min(0).max(1000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => {
    if (
      value.indexedTextBytes < 1 ||
      value.indexedTextBytes > value.extractedTextBytes
    )
      return false;
    if (value.format === "pdf") {
      const pages = value.pages;
      if (
        !pages ||
        value.messages ||
        pages.empty.length >= pages.total ||
        value.chunks < pages.total - pages.empty.length ||
        pages.ocr.some((p) => p > pages.total) ||
        pages.empty.some((p) => p > pages.total) ||
        new Set(pages.ocr).size !== pages.ocr.length ||
        new Set(pages.empty).size !== pages.empty.length ||
        Boolean(value.ocrExtractor) !== pages.ocr.length > 0
      )
        return false;
    } else if (value.pages || value.ocrExtractor) return false;
    if (value.format === "email") {
      if (
        !value.messages ||
        value.messages.empty >= value.messages.total ||
        value.chunks < value.messages.total - value.messages.empty
      )
        return false;
    } else if (value.messages) return false;
    return true;
  });
export type IngestionManifest = z.infer<typeof IngestionManifestSchema>;
