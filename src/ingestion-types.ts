import { z } from "zod";
import {
  ContextAttachmentSchema,
  ContextReferenceSchema,
  ContextSourceSchema,
} from "./context-types.js";
import {
  RetrievalIdSchema,
  RetrievalIndexResultSchema,
} from "./retrieval-types.js";
import { IngestionManifestSchema } from "./ingestion-metadata.js";

export const EmailDocumentSchema = z
  .object({
    type: z.literal("email"),
    source: ContextSourceSchema,
    threadId: RetrievalIdSchema,
    messages: z
      .array(
        z
          .object({ id: RetrievalIdSchema, text: z.string().max(1_048_576) })
          .strict(),
      )
      .min(1)
      .max(1000)
      .refine(
        (messages) =>
          new Set(messages.map((message) => message.id)).size ===
          messages.length,
      ),
  })
  .strict();
export type EmailDocument = z.infer<typeof EmailDocumentSchema>;
export const IngestionDocumentSchema = z.union([
  ContextAttachmentSchema.options[0],
  ContextAttachmentSchema.options[2],
  ContextReferenceSchema.extend({
    mediaType: z.enum(["text/plain", "text/markdown", "application/pdf"]),
  }),
  EmailDocumentSchema,
]);
export type IngestionDocument = z.infer<typeof IngestionDocumentSchema>;
export const IngestRequestSchema = z
  .object({
    corpus: RetrievalIdSchema,
    document: IngestionDocumentSchema,
    chunking: z
      .object({ maxBytes: z.number().int().min(128).max(16_384) })
      .strict()
      .optional(),
    idleTimeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();
export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export const IngestResultSchema = RetrievalIndexResultSchema.safeExtend({
  ingestion: IngestionManifestSchema,
}).strict();
export type IngestResult = z.infer<typeof IngestResultSchema>;
export * from "./ingestion-metadata.js";
