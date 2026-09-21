import { z } from "zod";
import {
  ContextSourceSchema,
  validContextResult,
  type ContextManifest,
} from "./context-types.js";

export const RetrievalIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const EmbeddingIdentitySchema = z
  .object({
    providerId: RetrievalIdSchema,
    vendor: RetrievalIdSchema,
    accountId: RetrievalIdSchema,
    authMode: z.enum(["api-key", "none"]),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/),
    dimensions: z.number().int().min(1).max(4096),
  })
  .strict();
export type EmbeddingIdentity = z.infer<typeof EmbeddingIdentitySchema>;
export const VectorIndexSchema = EmbeddingIdentitySchema.extend({
  metric: z.literal("cosine"),
  version: RetrievalIdSchema,
}).strict();
export type VectorIndex = z.infer<typeof VectorIndexSchema>;

export const RetrievalRequestSchema = z
  .object({
    corpus: RetrievalIdSchema,
    sourceIds: z
      .array(RetrievalIdSchema)
      .min(1)
      .max(1000)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    query: z.string().trim().min(1).max(16_384).optional(),
    limit: z.number().int().min(1).max(16).optional(),
    maxContextBytes: z.number().int().min(1).max(262_144).optional(),
    minScore: z.number().min(-1).max(1).optional(),
  })
  .strict();
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;
export const RetrievalSearchSchema = RetrievalRequestSchema.extend({
  query: z.string().trim().min(1).max(16_384),
});
export type RetrievalSearch = z.infer<typeof RetrievalSearchSchema>;

export const RetrievalChunkSchema = z
  .object({
    id: RetrievalIdSchema,
    text: z.string().min(1).max(16_384),
    location: ContextSourceSchema.shape.location,
  })
  .strict();
export const RetrievalIndexRequestSchema = z
  .object({
    corpus: RetrievalIdSchema,
    source: ContextSourceSchema,
    chunks: z
      .array(RetrievalChunkSchema)
      .min(1)
      .max(256)
      .refine((v) => new Set(v.map((chunk) => chunk.id)).size === v.length),
  })
  .strict();
export type RetrievalIndexRequest = z.infer<typeof RetrievalIndexRequestSchema>;
export const RetrievalDeleteSchema = z
  .object({
    corpus: RetrievalIdSchema,
    sourceId: RetrievalIdSchema,
    revision: RetrievalIdSchema,
  })
  .strict();
export type RetrievalDelete = z.infer<typeof RetrievalDeleteSchema>;

export const RetrievalHitSchema = z
  .object({
    chunkId: RetrievalIdSchema,
    source: ContextSourceSchema,
    text: z.string().min(1).max(16_384),
    /** Exact cosine similarity, not a confidence or entailment measurement. */
    score: z.number().min(-1).max(1),
    documentSha256: sha256,
  })
  .strict();
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;
export const RetrievalResultSchema = z
  .object({
    corpus: RetrievalIdSchema,
    index: VectorIndexSchema,
    hits: z.array(RetrievalHitSchema).max(16),
    /** More matching passages existed than fit the requested limit or byte budget. */
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.hits.map((hit) => hit.chunkId)).size ===
        value.hits.length && value.hits.every((hit) => validSource(hit.source)),
  );
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;
export const RetrievalIndexResultSchema = z
  .object({
    corpus: RetrievalIdSchema,
    sourceId: RetrievalIdSchema,
    revision: RetrievalIdSchema,
    documentSha256: sha256,
    chunks: z.number().int().min(1).max(256),
    status: z.enum(["indexed", "unchanged"]),
  })
  .strict();
export type RetrievalIndexResult = z.infer<typeof RetrievalIndexResultSchema>;
export const RetrievalDeleteResultSchema = RetrievalDeleteSchema.extend({
  deleted: z.boolean(),
});
export type RetrievalDeleteResult = z.infer<typeof RetrievalDeleteResultSchema>;

export function validSource(
  source: z.infer<typeof ContextSourceSchema>,
): boolean {
  return validContextResult({
    sources: [
      {
        ...source,
        mediaType: "text/plain",
        bytes: 1,
        sha256: "0".repeat(64),
        origin: "inline",
      },
    ],
  });
}

export function validRetrievalSelection(
  result: RetrievalResult,
  request: RetrievalRequest,
): boolean {
  return (
    result.corpus === request.corpus &&
    result.hits.length <= (request.limit ?? 8) &&
    result.hits.every(
      (hit) =>
        (!request.sourceIds || request.sourceIds.includes(hit.source.id)) &&
        hit.score >= (request.minScore ?? -1),
    ) &&
    result.hits.reduce(
      (sum, hit) => sum + new TextEncoder().encode(hit.text).byteLength,
      0,
    ) <= (request.maxContextBytes ?? 65_536)
  );
}
export function validRetrievalLinks(value: {
  retrieval?: RetrievalResult;
  sources?: ContextManifest[];
}): boolean {
  const sources = (value.sources ?? []).filter(
    (source) => source.origin === "retrieval",
  );
  const hits = value.retrieval?.hits ?? [];
  return (
    sources.length === hits.length &&
    hits.every((hit) =>
      sources.some(
        (source) =>
          source.id === hit.chunkId &&
          source.revision === hit.source.revision &&
          source.location?.documentId === hit.source.id &&
          source.bytes === new TextEncoder().encode(hit.text).byteLength,
      ),
    )
  );
}
