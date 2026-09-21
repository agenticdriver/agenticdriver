import { setImmediate } from "node:timers/promises";
import { DriverError, abortable } from "./errors.js";
import type { ExecutionContext } from "./types.js";
import type { RetrievalHit, VectorIndex } from "./retrieval-types.js";

export interface VectorScope {
  corpus: string;
  namespace: string;
  /** Only these exact source revisions may participate in similarity search. */
  sources: Readonly<Record<string, string>>;
}
export interface IndexedDocument {
  sourceId: string;
  revision: string;
  digest: string;
  chunks: number;
}
export interface StoredChunk extends Omit<RetrievalHit, "score"> {
  vector: number[];
}
export interface VectorSearchResult {
  hits: RetrievalHit[];
  truncated: boolean;
}
/** Stores are host-owned. Implementations must filter scope before ranking and replace documents atomically. */
export interface VectorStore {
  ensureIndex(
    corpus: string,
    index: VectorIndex,
    context: ExecutionContext,
  ): Promise<void>;
  documents(
    scope: VectorScope,
    context: ExecutionContext,
  ): Promise<IndexedDocument[]>;
  replace(
    scope: VectorScope,
    document: IndexedDocument,
    chunks: StoredChunk[],
    expectedDigest: string | null,
    context: ExecutionContext,
  ): Promise<void>;
  search(
    scope: VectorScope,
    vector: number[],
    limit: number,
    minScore: number,
    context: ExecutionContext,
  ): Promise<VectorSearchResult>;
  delete(
    scope: VectorScope,
    sourceId: string,
    revision: string,
    context: ExecutionContext,
  ): Promise<boolean>;
}

export function normalizedVector(
  vector: readonly number[],
  dimensions: number,
): number[] {
  if (vector.length !== dimensions || vector.some((n) => !Number.isFinite(n)))
    throw new DriverError(
      "INVALID_EMBEDDING",
      "Embedding dimensions and finite values must match the configured index.",
    );
  const max = Math.max(...vector.map(Math.abs));
  if (!max)
    throw new DriverError(
      "INVALID_EMBEDDING",
      "Zero-length embeddings cannot be indexed or searched.",
    );
  const scaled = vector.map((n) => n / max);
  const length = Math.sqrt(scaled.reduce((sum, n) => sum + n * n, 0));
  return scaled.map((n) => n / length);
}
export function indexKey(index: VectorIndex): string {
  return JSON.stringify([
    index.providerId,
    index.vendor,
    index.accountId,
    index.authMode,
    index.model,
    index.dimensions,
    index.metric,
    index.version,
  ]);
}
export function indexMismatch(): never {
  throw new DriverError(
    "INDEX_INCOMPATIBLE",
    "This corpus has a different embedding identity or index version. Select a new corpus or explicitly rebuild its index.",
  );
}
export function revisionConflict(): never {
  throw new DriverError(
    "SOURCE_CONFLICT",
    "The indexed source changed. Reconcile its current revision before retrying the mutation.",
  );
}
export function matches(
  scope: VectorScope,
  sourceId: string,
  revision: string,
): boolean {
  return (
    Object.hasOwn(scope.sources, sourceId) &&
    scope.sources[sourceId] === revision
  );
}
export function keepBest(
  hits: RetrievalHit[],
  chunk: StoredChunk,
  query: number[],
  limit: number,
  minScore: number,
): void {
  if (chunk.vector.length !== query.length) indexMismatch();
  const score = Math.max(
    -1,
    Math.min(
      1,
      chunk.vector.reduce((sum, n, i) => sum + n * query[i]!, 0),
    ),
  );
  if (!Number.isFinite(score)) indexMismatch();
  if (score < minScore) return;
  const { vector: _vector, ...hit } = chunk;
  hits.push({ ...hit, score });
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
  );
  if (hits.length > limit) hits.length = limit;
}
export function storeLimits(
  options: { maxChunks?: number; maxBytes?: number } = {},
) {
  const limits = {
    maxChunks: options.maxChunks ?? 20_000,
    maxBytes: options.maxBytes ?? 134_217_728,
  };
  if (
    !Number.isSafeInteger(limits.maxChunks) ||
    limits.maxChunks < 1 ||
    limits.maxChunks > 1_000_000 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > 1_073_741_824
  )
    throw new Error(
      "Vector store limits must be positive integers, at most 1M chunks and 1 GiB payload.",
    );
  return limits;
}
export function storeFull(): never {
  throw new DriverError(
    "INDEX_FULL",
    "The vector index reached its configured capacity. Delete stale sources or increase the host limit.",
  );
}

/** Serializes async connection work while allowing queued callers to cancel immediately. */
export class StoreQueue {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(context: ExecutionContext, fn: () => T | Promise<T>): Promise<T> {
    const work = this.pending.then(() => {
      context.signal.throwIfAborted();
      return fn();
    });
    this.pending = work.catch(() => {});
    return abortable(work, context.signal);
  }
}

/** Bounded deterministic reference store. Use SQLite or an application store for persistence. */
export class MemoryVectorStore implements VectorStore {
  private readonly indexes = new Map<string, string>();
  private readonly data = new Map<
    string,
    { document: IndexedDocument; chunks: StoredChunk[]; bytes: number }
  >();
  private readonly queue = new StoreQueue();
  private readonly limits;
  constructor(options: { maxChunks?: number; maxBytes?: number } = {}) {
    this.limits = storeLimits(options);
  }
  private key(scope: VectorScope, source: string) {
    return JSON.stringify([scope.corpus, scope.namespace, source]);
  }
  async ensureIndex(
    corpus: string,
    index: VectorIndex,
    context: ExecutionContext,
  ): Promise<void> {
    return this.queue.run(context, () => {
      const existing = this.indexes.get(corpus),
        key = indexKey(index);
      if (existing !== undefined && existing !== key) indexMismatch();
      if (!existing && this.indexes.size >= 1000) storeFull();
      this.indexes.set(corpus, key);
    });
  }
  async documents(
    scope: VectorScope,
    context: ExecutionContext,
  ): Promise<IndexedDocument[]> {
    return this.queue.run(context, () =>
      Object.keys(scope.sources).flatMap((id) => {
        const item = this.data.get(this.key(scope, id));
        return item ? [structuredClone(item.document)] : [];
      }),
    );
  }
  async replace(
    scope: VectorScope,
    document: IndexedDocument,
    chunks: StoredChunk[],
    expectedDigest: string | null,
    context: ExecutionContext,
  ): Promise<void> {
    return this.queue.run(context, () => {
      const key = this.key(scope, document.sourceId),
        old = this.data.get(key);
      if ((old?.document.digest ?? null) !== expectedDigest) revisionConflict();
      const bytes = Buffer.byteLength(JSON.stringify(chunks));
      let count = chunks.length,
        total = bytes;
      const ids = new Set(chunks.map((chunk) => chunk.chunkId));
      for (const [existingKey, value] of this.data) {
        if (existingKey === key) continue;
        const [corpus, namespace] = JSON.parse(existingKey) as string[];
        if (
          corpus === scope.corpus &&
          namespace === scope.namespace &&
          value.chunks.some((c) => ids.has(c.chunkId))
        )
          throw new DriverError(
            "CHUNK_CONFLICT",
            "Chunk IDs must be unique within a corpus namespace.",
          );
        count += value.chunks.length;
        total += value.bytes;
      }
      if (count > this.limits.maxChunks || total > this.limits.maxBytes)
        storeFull();
      context.signal.throwIfAborted();
      this.data.set(key, structuredClone({ document, chunks, bytes }));
    });
  }
  async search(
    scope: VectorScope,
    vector: number[],
    limit: number,
    minScore: number,
    context: ExecutionContext,
  ): Promise<VectorSearchResult> {
    return this.queue.run(context, async () => {
      const hits: RetrievalHit[] = [];
      let scanned = 0;
      for (const id of Object.keys(scope.sources)) {
        const item = this.data.get(this.key(scope, id));
        if (!item || !matches(scope, id, item.document.revision)) continue;
        for (const chunk of item.chunks) {
          context.signal.throwIfAborted();
          keepBest(hits, chunk, vector, limit + 1, minScore);
          if (++scanned % 128 === 0) {
            context.reportProgress();
            await setImmediate();
          }
        }
      }
      context.signal.throwIfAborted();
      context.reportProgress();
      return structuredClone({
        hits: hits.slice(0, limit),
        truncated: hits.length > limit,
      });
    });
  }
  async delete(
    scope: VectorScope,
    sourceId: string,
    revision: string,
    context: ExecutionContext,
  ): Promise<boolean> {
    return this.queue.run(context, () => {
      const key = this.key(scope, sourceId),
        existing = this.data.get(key);
      if (!existing) return false;
      if (existing.document.revision !== revision) revisionConflict();
      return this.data.delete(key);
    });
  }
}
