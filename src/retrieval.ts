import { createHash } from "node:crypto";
import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { validateEmbeddingInput, type EmbeddingAdapter } from "./embeddings.js";
import {
  RetrievalDeleteSchema,
  RetrievalIdSchema,
  RetrievalIndexRequestSchema,
  RetrievalResultSchema,
  RetrievalSearchSchema,
  VectorIndexSchema,
  validSource,
  type RetrievalDelete,
  type RetrievalDeleteResult,
  type RetrievalIndexRequest,
  type RetrievalIndexResult,
  type RetrievalRequest,
  type RetrievalResult,
  type RetrievalSearch,
  type VectorIndex,
} from "./retrieval-types.js";
import {
  indexKey,
  indexMismatch,
  matches,
  normalizedVector,
  revisionConflict,
  type StoredChunk,
  type VectorScope,
  type VectorStore,
} from "./vector-store.js";
import type { ContextAttachment } from "./context-types.js";
import type { ExecutionContext } from "./types.js";

export type RetrievalOperation = "search" | "index" | "delete";
export interface RetrievalAuthorization {
  namespace: string;
  /** Current app-owned revisions. An empty map grants no source access. */
  sources: Record<string, string>;
}
export interface RetrievalCorpus {
  id: string;
  version: string;
  embedding: EmbeddingAdapter;
  store: VectorStore;
  /** Required even for embedded callers. Never derive these grants from model text. */
  authorize(
    request: {
      corpus: string;
      operation: RetrievalOperation;
      sourceIds?: readonly string[];
    },
    context: ExecutionContext,
  ): RetrievalAuthorization | null | Promise<RetrievalAuthorization | null>;
}
const authorizationSchema = z
  .object({
    namespace: RetrievalIdSchema,
    sources: z
      .record(RetrievalIdSchema, RetrievalIdSchema)
      .refine((v) => Object.keys(v).length <= 1000),
  })
  .strict();
type Corpus = Omit<RetrievalCorpus, "version"> & { index: VectorIndex };

/** Optional, app-authorized retrieval. The service never discovers documents, identities or models implicitly. */
export class RetrievalService {
  private readonly corpora = new Map<string, Corpus>();
  constructor(corpora: RetrievalCorpus[]) {
    if (corpora.length > 1000)
      throw new Error("At most 1000 retrieval corpora may be configured.");
    for (const corpus of corpora) {
      const id = RetrievalIdSchema.parse(corpus.id);
      if (this.corpora.has(id) || typeof corpus.authorize !== "function")
        throw new Error("Each corpus needs a unique ID and an authorizer.");
      const index = Object.freeze(
        VectorIndexSchema.parse({
          ...corpus.embedding.info,
          metric: "cosine",
          version: corpus.version,
        }),
      );
      this.corpora.set(id, { ...corpus, index });
    }
  }
  private corpus(id: string): Corpus {
    const corpus = this.corpora.get(id);
    if (!corpus) unavailable();
    // Adapter mutation cannot silently point an existing index at a different model/account.
    if (
      indexKey({
        ...corpus!.embedding.info,
        metric: "cosine",
        version: corpus!.index.version,
      }) !== indexKey(corpus!.index)
    )
      indexMismatch();
    return corpus!;
  }
  private async scope(
    corpus: Corpus,
    operation: RetrievalOperation,
    sourceIds: readonly string[] | undefined,
    context: ExecutionContext,
  ): Promise<VectorScope> {
    context.signal.throwIfAborted();
    const grant = authorizationSchema.safeParse(
      await abortable(
        Promise.resolve(
          corpus.authorize(
            {
              corpus: corpus.id,
              operation,
              ...(sourceIds ? { sourceIds: [...sourceIds] } : {}),
            },
            context,
          ),
        ),
        context.signal,
      ),
    );
    if (
      !grant.success ||
      sourceIds?.some((id) => !Object.hasOwn(grant.data.sources, id))
    )
      unavailable();
    const data = grant.data!;
    const sources = Object.fromEntries(
      (sourceIds ?? Object.keys(data.sources)).map((id) => [
        id,
        data.sources[id]!,
      ]),
    );
    context.reportProgress();
    return { corpus: corpus.id, namespace: data.namespace, sources };
  }
  private async checkedScope(
    corpus: Corpus,
    operation: RetrievalOperation,
    scope: VectorScope,
    context: ExecutionContext,
  ): Promise<void> {
    const current = await this.scope(
      corpus,
      operation,
      Object.keys(scope.sources),
      context,
    );
    if (
      current.namespace !== scope.namespace ||
      Object.entries(scope.sources).some(
        ([id, revision]) => current.sources[id] !== revision,
      )
    )
      unavailable();
  }
  private async ready(
    corpus: Corpus,
    context: ExecutionContext,
  ): Promise<void> {
    await abortable(
      corpus.store.ensureIndex(corpus.id, corpus.index, context),
      context.signal,
    );
  }
  async index(
    input: RetrievalIndexRequest,
    context: ExecutionContext,
  ): Promise<RetrievalIndexResult> {
    const request = parse(RetrievalIndexRequestSchema, input),
      corpus = this.corpus(request.corpus);
    validateEmbeddingInput(request.chunks.map((chunk) => chunk.text));
    if (
      !validSource(request.source) ||
      request.chunks.some(
        (chunk) =>
          !validSource({
            ...request.source,
            location: { ...request.source.location, ...chunk.location },
          }) ||
          (chunk.location?.documentId !== undefined &&
            chunk.location.documentId !== request.source.id),
      ) ||
      (request.source.location?.documentId !== undefined &&
        request.source.location.documentId !== request.source.id)
    )
      throw new DriverError(
        "INVALID_RETRIEVAL",
        "Source locations and citation URIs must be consistent.",
      );
    const scope = await this.scope(
      corpus,
      "index",
      [request.source.id],
      context,
    );
    if (!matches(scope, request.source.id, request.source.revision))
      unavailable();
    await this.ready(corpus, context);
    const digest = createHash("sha256")
      .update(canonical({ source: request.source, chunks: request.chunks }))
      .digest("hex");
    const old = (
      await abortable(corpus.store.documents(scope, context), context.signal)
    )[0];
    const result: RetrievalIndexResult = {
      corpus: corpus.id,
      sourceId: request.source.id,
      revision: request.source.revision,
      documentSha256: digest,
      chunks: request.chunks.length,
      status: "indexed",
    };
    if (old?.revision === request.source.revision) {
      if (old.digest !== digest) revisionConflict();
      await this.checkedScope(corpus, "index", scope, context);
      return { ...result, status: "unchanged" };
    }
    const embedded = await abortable(
      corpus.embedding.embed(
        request.chunks.map((chunk) => chunk.text),
        context,
      ),
      context.signal,
    );
    if (
      !Array.isArray(embedded.vectors) ||
      embedded.vectors.length !== request.chunks.length
    )
      throw new DriverError(
        "INVALID_EMBEDDING",
        "The embedding batch must contain one vector per chunk.",
      );
    const chunks: StoredChunk[] = request.chunks.map((chunk, i) => ({
      chunkId: chunk.id,
      text: chunk.text,
      source: {
        ...request.source,
        location: {
          documentId: request.source.id,
          ...request.source.location,
          ...chunk.location,
        },
      },
      documentSha256: digest,
      vector: normalizedVector(embedded.vectors[i]!, corpus.index.dimensions),
    }));
    await this.checkedScope(corpus, "index", scope, context);
    context.signal.throwIfAborted();
    await abortable(
      corpus.store.replace(
        scope,
        {
          sourceId: request.source.id,
          revision: request.source.revision,
          digest,
          chunks: chunks.length,
        },
        chunks,
        old?.digest ?? null,
        context,
      ),
      context.signal,
    );
    context.reportProgress();
    return result;
  }
  async search(
    input: RetrievalSearch,
    context: ExecutionContext,
  ): Promise<RetrievalResult> {
    const request = parse(RetrievalSearchSchema, input),
      corpus = this.corpus(request.corpus);
    validateEmbeddingInput([request.query]);
    const scope = await this.scope(
      corpus,
      "search",
      request.sourceIds,
      context,
    );
    await this.ready(corpus, context);
    if (!Object.keys(scope.sources).length)
      return {
        corpus: corpus.id,
        index: { ...corpus.index },
        hits: [],
        truncated: false,
      };
    const embedded = await abortable(
      corpus.embedding.embed([request.query], context),
      context.signal,
    );
    if (!Array.isArray(embedded.vectors) || embedded.vectors.length !== 1)
      throw new DriverError(
        "INVALID_EMBEDDING",
        "The query must produce exactly one embedding.",
      );
    const vector = normalizedVector(
      embedded.vectors[0]!,
      corpus.index.dimensions,
    );
    const found = await abortable(
      corpus.store.search(
        scope,
        vector,
        request.limit ?? 8,
        request.minScore ?? -1,
        context,
      ),
      context.signal,
    );
    const parsed = RetrievalResultSchema.safeParse({
      corpus: corpus.id,
      index: corpus.index,
      ...found,
    });
    if (
      !parsed.success ||
      parsed.data.hits.length > (request.limit ?? 8) ||
      parsed.data.hits.some(
        (hit) =>
          !matches(scope, hit.source.id, hit.source.revision) ||
          hit.score < (request.minScore ?? -1),
      )
    )
      throw new DriverError(
        "INVALID_RETRIEVAL",
        "The vector store returned invalid or unscoped evidence.",
      );
    const documents = await abortable(
      corpus.store.documents(scope, context),
      context.signal,
    );
    // Re-check after every awaited read. Never widen the initial source grant.
    await this.checkedScope(corpus, "search", scope, context);
    const result = parsed.data;
    let bytes = 0;
    result.hits = result.hits.filter((hit) => {
      const current = documents.find((doc) => doc.sourceId === hit.source.id);
      if (
        !current ||
        current.revision !== hit.source.revision ||
        current.digest !== hit.documentSha256
      )
        unavailable();
      const size = Buffer.byteLength(hit.text);
      if (bytes + size > (request.maxContextBytes ?? 65_536)) {
        result.truncated = true;
        return false;
      }
      bytes += size;
      return true;
    });
    context.signal.throwIfAborted();
    return result;
  }
  /** Reauthorize persisted evidence without repeating embedding, generation or tool effects. */
  async revalidate(
    request: RetrievalRequest,
    input: RetrievalResult,
    context: ExecutionContext,
  ): Promise<void> {
    const result = parse(RetrievalResultSchema, input),
      corpus = this.corpus(request.corpus);
    if (
      result.corpus !== request.corpus ||
      indexKey(result.index) !== indexKey(corpus.index)
    )
      indexMismatch();
    const scope = await this.scope(
      corpus,
      "search",
      request.sourceIds,
      context,
    );
    await this.ready(corpus, context);
    const documents = await abortable(
      corpus.store.documents(scope, context),
      context.signal,
    );
    if (
      result.hits.some(
        (hit) =>
          !matches(scope, hit.source.id, hit.source.revision) ||
          !documents.some(
            (doc) =>
              doc.sourceId === hit.source.id &&
              doc.revision === hit.source.revision &&
              doc.digest === hit.documentSha256,
          ),
      )
    )
      unavailable();
    await this.checkedScope(corpus, "search", scope, context);
    context.signal.throwIfAborted();
  }
  async delete(
    input: RetrievalDelete,
    context: ExecutionContext,
  ): Promise<RetrievalDeleteResult> {
    const request = parse(RetrievalDeleteSchema, input),
      corpus = this.corpus(request.corpus);
    const scope = await this.scope(
      corpus,
      "delete",
      [request.sourceId],
      context,
    );
    if (!matches(scope, request.sourceId, request.revision)) unavailable();
    await this.ready(corpus, context);
    await this.checkedScope(corpus, "delete", scope, context);
    return {
      ...request,
      deleted: await abortable(
        corpus.store.delete(scope, request.sourceId, request.revision, context),
        context.signal,
      ),
    };
  }
}

export function retrievalAttachments(
  result: RetrievalResult,
): ContextAttachment[] {
  return result.hits.map((hit) => ({
    type: "text",
    mediaType: "text/plain",
    text: hit.text,
    source: { ...hit.source, id: hit.chunkId },
  }));
}
function unavailable(): never {
  throw new DriverError(
    "CONTEXT_NOT_FOUND",
    "The selected context is unavailable or no longer authorized at that revision.",
  );
}
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_RETRIEVAL",
      "The retrieval request or evidence does not match the schema.",
    );
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export * from "./retrieval-types.js";
export { MemoryVectorStore } from "./vector-store.js";
export type {
  VectorStore,
  VectorScope,
  IndexedDocument,
  StoredChunk,
  VectorSearchResult,
} from "./vector-store.js";
export { SqliteVectorStore } from "./sqlite-vector-store.js";
export {
  OpenAIEmbeddingAdapter,
  DeterministicEmbeddingAdapter,
} from "./embeddings.js";
export type {
  EmbeddingAdapter,
  EmbeddingResult,
  OpenAIEmbeddingOptions,
} from "./embeddings.js";
