import { sqliteFile } from "./sqlite-file.js";
import { setImmediate } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { DriverError } from "./errors.js";
import type { ExecutionContext } from "./types.js";
import type { RetrievalHit, VectorIndex } from "./retrieval-types.js";
import {
  StoreQueue,
  indexKey,
  indexMismatch,
  keepBest,
  revisionConflict,
  storeFull,
  storeLimits,
  type IndexedDocument,
  type StoredChunk,
  type VectorScope,
  type VectorSearchResult,
  type VectorStore,
} from "./vector-store.js";

const retirementTable = `CREATE TABLE ad_vector_retirements(
  corpus TEXT NOT NULL, namespace TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
  PRIMARY KEY(corpus, namespace, source_id), FOREIGN KEY(corpus) REFERENCES ad_vector_indexes(corpus))`;
const retirementTriggers = ["INSERT", "UPDATE"].map(
  (operation) =>
    `CREATE TRIGGER ad_vector_retired_${operation.toLowerCase()} BEFORE ${operation} ON ad_vector_documents
  WHEN EXISTS(SELECT 1 FROM ad_vector_retirements r WHERE r.corpus=NEW.corpus AND r.namespace=NEW.namespace AND r.source_id=NEW.source_id)
  BEGIN SELECT RAISE(ABORT, 'SOURCE_RETIRED'); END`,
);

function existingSchema(db: DatabaseSync, fenced: boolean): boolean {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const names = [
    "ad_vector_indexes",
    "ad_vector_documents",
    "ad_vector_chunks",
    ...(fenced ? ["ad_vector_retirements"] : []),
  ];
  if (
    tables.length &&
    (version !== (fenced ? 2 : 1) ||
      tables.length !== names.length ||
      !tables.every((row) => names.includes(String(row.name))))
  )
    indexMismatch();
  if (!tables.length && version !== 0) indexMismatch();
  if (tables.length && fenced) {
    const guards = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger'")
      .all();
    if (
      guards.length !== retirementTriggers.length ||
      !retirementTriggers.every((sql) => guards.some((row) => row.sql === sql))
    )
      indexMismatch();
  }
  return tables.length > 0;
}

/** Persistent bounded exact cosine search; no extension, network service or approximate index required. */
export class SqliteVectorStore implements VectorStore {
  private readonly queue = new StoreQueue();
  private closed = false;
  readonly retire: VectorStore["retire"];
  private constructor(
    private readonly db: DatabaseSync,
    private readonly limits: ReturnType<typeof storeLimits>,
    private readonly maxRetiredSources?: number,
  ) {
    this.retire =
      maxRetiredSources === undefined
        ? undefined
        : this.retireSource.bind(this);
  }

  /** A dedicated host-owned database in a private directory. Requires Node >=22.13. */
  static async open(
    path: string,
    options: {
      maxChunks?: number;
      maxBytes?: number;
      retirement?: { maxSources: number };
    } = {},
  ): Promise<SqliteVectorStore> {
    const limits = storeLimits(options);
    const maxSources = options.retirement?.maxSources;
    if (
      options.retirement !== undefined &&
      (!Number.isSafeInteger(maxSources) ||
        maxSources! < 1 ||
        maxSources! > 1_000_000)
    )
      throw new DriverError(
        "INVALID_CONFIG",
        "Retirement capacity must be a positive integer of at most one million permanent source markers.",
      );
    const { path: canonical } = await sqliteFile(path, true, "INDEX");
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new DriverError(
        "SQLITE_UNAVAILABLE",
        "The SQLite vector adapter requires Node 22.13 or later.",
      );
    }
    const db = new sqlite.DatabaseSync(canonical);
    try {
      const fenced = maxSources !== undefined;
      // Validate before changing an existing database's journal settings, then
      // recheck either format under the initialization write transaction.
      existingSchema(db, fenced);
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = existingSchema(db, fenced);
        db.exec(`CREATE TABLE IF NOT EXISTS ad_vector_indexes(corpus TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ad_vector_documents(
          corpus TEXT NOT NULL, namespace TEXT NOT NULL, source_id TEXT NOT NULL,
          revision TEXT NOT NULL, digest TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(corpus, namespace, source_id), FOREIGN KEY(corpus) REFERENCES ad_vector_indexes(corpus));
        CREATE TABLE IF NOT EXISTS ad_vector_chunks(
          corpus TEXT NOT NULL, namespace TEXT NOT NULL, source_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
          payload TEXT NOT NULL, PRIMARY KEY(corpus, namespace, chunk_id),
          FOREIGN KEY(corpus, namespace, source_id) REFERENCES ad_vector_documents(corpus, namespace, source_id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS ad_vector_source ON ad_vector_chunks(corpus, namespace, source_id, chunk_id);
        `);

        if (fenced) {
          if (!existing)
            db.exec(retirementTable + ";" + retirementTriggers.join(";"));
        }
        db.exec(`PRAGMA user_version=${fenced ? 2 : 1}`);
        if (fenced) existingSchema(db, true);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return new SqliteVectorStore(db, limits, maxSources);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private run<T>(
    context: ExecutionContext,
    work: () => T | Promise<T>,
  ): Promise<T> {
    return this.queue.run(context, async () => {
      if (this.closed)
        throw new DriverError("INDEX_CLOSED", "The vector database is closed.");
      try {
        return await work();
      } catch (error) {
        if (error instanceof DriverError || context.signal.aborted) throw error;
        throw new DriverError(
          "INDEX_STORAGE_ERROR",
          "The vector database operation failed. Inspect private host diagnostics.",
        );
      }
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async ensureIndex(
    corpus: string,
    index: VectorIndex,
    context: ExecutionContext,
  ): Promise<void> {
    return this.run(context, () =>
      this.transaction(() => {
        const key = indexKey(index),
          old = this.db
            .prepare("SELECT descriptor FROM ad_vector_indexes WHERE corpus=?")
            .get(corpus);
        if (old && old.descriptor !== key) indexMismatch();
        if (!old) {
          if (
            Number(
              this.db
                .prepare("SELECT COUNT(*) AS n FROM ad_vector_indexes")
                .get()!.n,
            ) >= 1000
          )
            storeFull();
          this.db
            .prepare(
              "INSERT INTO ad_vector_indexes(corpus, descriptor) VALUES (?, ?)",
            )
            .run(corpus, key);
        }
      }),
    );
  }
  private document(
    scope: VectorScope,
    id: string,
  ): IndexedDocument | undefined {
    const row = this.db
      .prepare(
        "SELECT source_id, revision, digest, chunks FROM ad_vector_documents WHERE corpus=? AND namespace=? AND source_id=?",
      )
      .get(scope.corpus, scope.namespace, id);
    return row
      ? {
          sourceId: String(row.source_id),
          revision: String(row.revision),
          digest: String(row.digest),
          chunks: Number(row.chunks),
        }
      : undefined;
  }
  async documents(
    scope: VectorScope,
    context: ExecutionContext,
  ): Promise<IndexedDocument[]> {
    return this.run(context, () =>
      Object.keys(scope.sources).flatMap((id) => {
        const row = this.document(scope, id);
        return row ? [row] : [];
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
    return this.run(context, () =>
      this.transaction(() => {
        if (
          this.maxRetiredSources !== undefined &&
          this.retirement(scope, document.sourceId)
        )
          throw new DriverError(
            "SOURCE_RETIRED",
            "This source ID is permanently retired. Select a new immutable source ID.",
          );
        const old = this.document(scope, document.sourceId);
        if ((old?.digest ?? null) !== expectedDigest) revisionConflict();
        const payloads = chunks.map((chunk) => JSON.stringify(chunk));
        const bytes = payloads.reduce(
          (sum, payload) => sum + Buffer.byteLength(payload),
          0,
        );
        this.db
          .prepare(
            "DELETE FROM ad_vector_documents WHERE corpus=? AND namespace=? AND source_id=?",
          )
          .run(scope.corpus, scope.namespace, document.sourceId);
        const totals = this.db
          .prepare(
            "SELECT COALESCE(SUM(chunks), 0) AS chunks, COALESCE(SUM(bytes), 0) AS bytes FROM ad_vector_documents",
          )
          .get()!;
        if (
          Number(totals.chunks) + chunks.length > this.limits.maxChunks ||
          Number(totals.bytes) + bytes > this.limits.maxBytes
        )
          storeFull();
        const collision = this.db.prepare(
          "SELECT source_id FROM ad_vector_chunks WHERE corpus=? AND namespace=? AND chunk_id=?",
        );
        for (const chunk of chunks)
          if (collision.get(scope.corpus, scope.namespace, chunk.chunkId))
            throw new DriverError(
              "CHUNK_CONFLICT",
              "Chunk IDs must be unique within a corpus namespace.",
            );
        this.db
          .prepare(
            "INSERT INTO ad_vector_documents(corpus, namespace, source_id, revision, digest, chunks, bytes) VALUES(?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            scope.corpus,
            scope.namespace,
            document.sourceId,
            document.revision,
            document.digest,
            chunks.length,
            bytes,
          );
        const insert = this.db.prepare(
          "INSERT INTO ad_vector_chunks(corpus, namespace, source_id, chunk_id, payload) VALUES(?, ?, ?, ?, ?)",
        );
        chunks.forEach((chunk, i) => {
          context.signal.throwIfAborted();
          insert.run(
            scope.corpus,
            scope.namespace,
            document.sourceId,
            chunk.chunkId,
            payloads[i]!,
          );
        });
        context.signal.throwIfAborted();
      }),
    );
  }
  async search(
    scope: VectorScope,
    vector: number[],
    limit: number,
    minScore: number,
    context: ExecutionContext,
  ): Promise<VectorSearchResult> {
    return this.run(context, async () => {
      const hits: RetrievalHit[] = [];
      // A read snapshot avoids skipped/duplicated rows when another process updates the index.
      this.db.exec("BEGIN");
      try {
        const query = this.db
          .prepare(`SELECT c.chunk_id, c.payload FROM ad_vector_chunks c
          JOIN ad_vector_documents d USING(corpus, namespace, source_id)
          WHERE c.corpus=? AND c.namespace=? AND c.source_id=? AND d.revision=? AND c.chunk_id>?
          ORDER BY c.chunk_id LIMIT 128`);
        for (const [sourceId, revision] of Object.entries(scope.sources)) {
          let after = "";
          while (true) {
            context.signal.throwIfAborted();
            const rows = query.all(
              scope.corpus,
              scope.namespace,
              sourceId,
              revision,
              after,
            );
            if (!rows.length) break;
            for (const row of rows)
              keepBest(
                hits,
                JSON.parse(String(row.payload)) as StoredChunk,
                vector,
                limit + 1,
                minScore,
              );
            after = String(rows[rows.length - 1]!.chunk_id);
            context.reportProgress();
            await setImmediate();
          }
        }
        context.signal.throwIfAborted();
        this.db.exec("COMMIT");
        return { hits: hits.slice(0, limit), truncated: hits.length > limit };
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  private retirement(scope: VectorScope, sourceId: string) {
    return this.db
      .prepare(
        "SELECT revision FROM ad_vector_retirements WHERE corpus=? AND namespace=? AND source_id=?",
      )
      .get(scope.corpus, scope.namespace, sourceId);
  }
  private async retireSource(
    scope: VectorScope,
    sourceId: string,
    revision: string,
    context: ExecutionContext,
  ) {
    return this.run(context, () =>
      this.transaction(() => {
        const old = this.document(scope, sourceId),
          marker = this.retirement(scope, sourceId);
        if (
          (old && old.revision !== revision) ||
          (marker && marker.revision !== revision)
        )
          revisionConflict();
        if (!marker) {
          const count = Number(
            this.db
              .prepare("SELECT COUNT(*) AS n FROM ad_vector_retirements")
              .get()!.n,
          );
          if (count >= this.maxRetiredSources!)
            throw new DriverError(
              "RETIREMENT_FULL",
              "Permanent source retirement capacity is full. Increase the host limit; retirement markers cannot be evicted.",
            );
          this.db
            .prepare(
              "INSERT INTO ad_vector_retirements(corpus, namespace, source_id, revision) VALUES(?,?,?,?)",
            )
            .run(scope.corpus, scope.namespace, sourceId, revision);
        }
        this.db
          .prepare(
            "DELETE FROM ad_vector_documents WHERE corpus=? AND namespace=? AND source_id=?",
          )
          .run(scope.corpus, scope.namespace, sourceId);
        context.signal.throwIfAborted();
        return { retired: true as const, deleted: old !== undefined };
      }),
    );
  }
  async delete(
    scope: VectorScope,
    sourceId: string,
    revision: string,
    context: ExecutionContext,
  ): Promise<boolean> {
    return this.run(context, () =>
      this.transaction(() => {
        const old = this.document(scope, sourceId);
        if (!old) return false;
        if (old.revision !== revision) revisionConflict();
        this.db
          .prepare(
            "DELETE FROM ad_vector_documents WHERE corpus=? AND namespace=? AND source_id=?",
          )
          .run(scope.corpus, scope.namespace, sourceId);
        return true;
      }),
    );
  }
  async close(): Promise<void> {
    return this.queue.run(
      {
        runId: "close",
        subject: "host",
        signal: new AbortController().signal,
        reportProgress() {},
      },
      () => {
        if (!this.closed) {
          this.db.close();
          this.closed = true;
        }
      },
    );
  }
}
