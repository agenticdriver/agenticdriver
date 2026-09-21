import { z } from "zod";

const sourceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const position = z.number().int().min(1).max(1_000_000);
export const ContextMediaTypeSchema = z.enum([
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
export type ContextMediaType = z.infer<typeof ContextMediaTypeSchema>;
export const ContextSourceSchema = z
  .object({
    id: sourceId,
    revision: sourceId,
    title: z.string().max(256).optional(),
    /** Display metadata only. The SDK never fetches this URI. */
    uri: z
      .string()
      .max(2048)
      .regex(/^(https|app):\/\/[^\s]+$/)
      .optional(),
    location: z
      .object({
        documentId: sourceId.optional(),
        page: position.optional(),
        pageEnd: position.optional(),
        startLine: position.optional(),
        endLine: position.optional(),
        section: z.string().max(256).optional(),
        threadId: sourceId.optional(),
        messageId: sourceId.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ContextSource = z.infer<typeof ContextSourceSchema>;

/** Resolver payloads have a larger bound than inline wire payloads; decoded budgets are checked separately. */
export const ContextAttachmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      source: ContextSourceSchema,
      mediaType: z.enum(["text/plain", "text/markdown"]),
      text: z.string().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      source: ContextSourceSchema,
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      data: z.string().min(1).max(44_739_244),
    })
    .strict(),
  z
    .object({
      type: z.literal("pdf"),
      source: ContextSourceSchema,
      mediaType: z.literal("application/pdf"),
      data: z.string().min(1).max(44_739_244),
    })
    .strict(),
]);
export type ContextAttachment = z.infer<typeof ContextAttachmentSchema>;
export const ContextReferenceSchema = z
  .object({
    type: z.literal("reference"),
    id: sourceId,
    revision: sourceId,
    mediaType: ContextMediaTypeSchema,
  })
  .strict();
export type ContextReference = z.infer<typeof ContextReferenceSchema>;
export const ContextInputSchema = z.union([
  ContextAttachmentSchema,
  ContextReferenceSchema,
]);
export type ContextInput = z.infer<typeof ContextInputSchema>;
export const ContextManifestSchema = ContextSourceSchema.extend({
  mediaType: ContextMediaTypeSchema,
  bytes: z.number().int().positive().max(33_554_432),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(["inline", "reference"]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const ArtifactRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^/\\\u0000-\u001f]+$/),
    mediaType: z.enum(["text/plain", "text/markdown", "application/json"]),
  })
  .strict();
export type ArtifactRequest = z.infer<typeof ArtifactRequestSchema>;
export const DraftArtifactSchema = ArtifactRequestSchema.extend({
  id: z.uuid(),
  status: z.literal("draft"),
  content: z.string().max(262_144),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** IDs of supplied context, not an assertion that every generated claim is supported. */
  sourceIds: z.array(sourceId).max(16),
}).strict();
export type DraftArtifact = z.infer<typeof DraftArtifactSchema>;

/** Validate relationships which JSON shape schemas alone cannot express. */
export function validContextResult(value: {
  sources?: ContextManifest[];
  artifacts?: DraftArtifact[];
}): boolean {
  const ids = new Set((value.sources ?? []).map((source) => source.id));
  if (ids.size !== (value.sources?.length ?? 0)) return false;
  for (const source of value.sources ?? []) {
    const location = source.location;
    if (
      (location?.pageEnd !== undefined &&
        (location.page === undefined || location.pageEnd < location.page)) ||
      (location?.endLine !== undefined &&
        (location.startLine === undefined ||
          location.endLine < location.startLine))
    )
      return false;
    if (source.uri)
      try {
        const uri = new URL(source.uri);
        if (uri.username || uri.password) return false;
      } catch {
        return false;
      }
  }
  return (value.artifacts ?? []).every(
    (artifact) =>
      artifact.name !== "." &&
      artifact.name !== ".." &&
      new Set(artifact.sourceIds).size === artifact.sourceIds.length &&
      artifact.sourceIds.every((id) => ids.has(id)),
  );
}
