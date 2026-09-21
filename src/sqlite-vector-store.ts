import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

/** Persistent bounded exact cosine search; no extension, network service or approximate index required. */
export class SqliteVectorStore implements VectorStore {
  private readonly queue = new StoreQueue();
  private closed = false;
  private constructor(
    private readonly db: DatabaseSync,
    private readonly limits: ReturnType<typeof storeLimits>,
  ) {}

  /** A dedicated host-owned database in a private directory. Requires Node >=22.13. */
  static async open(
    path: string,
    options: { maxChunks?: number; maxBytes?: number } = {},
  ): Promise<SqliteVectorStore> {
    const limits = storeLimits(options);
    const absolute = resolve(path),
      parent = dirname(absolute);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await lstat(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !privateFile(directory)
    )
      throw new DriverError(
        "INDEX_STORAGE_UNSAFE",
        "Use a private, host-owned directory for the vector database.",
      );
    const canonical = join(await realpath(parent), basename(absolute));
    const file = await open(
      canonical,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !privateFile(stat))
        throw new DriverError(
          "INDEX_STORAGE_UNSAFE",
          "The vector database must be a private regular file with one link.",
        );
    } finally {
      await file.close();
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const stat = await lstat(canonical + suffix).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (
        stat &&
        (!stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          !privateFile(stat))
      )
        throw new DriverError(
          "INDEX_STORAGE_UNSAFE",
          "Vector database sidecar files must be private regular files.",
        );
    }
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
      // Fail closed on unrelated databases. No automatic schema migration or index replacement.
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (
        tables.length &&
        (version !== 1 ||
          tables.length !== 3 ||
          !tables.every((row) =>
            [
              "ad_vector_indexes",
              "ad_vector_documents",
              "ad_vector_chunks",
            ].includes(String(row.name)),
          ))
      )
        indexMismatch();
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS ad_vector_indexes(corpus TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ad_vector_documents(
          corpus TEXT NOT NULL, namespace TEXT NOT NULL, source_id TEXT NOT NULL,
          revision TEXT NOT NULL, digest TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(corpus, namespace, source_id), FOREIGN KEY(corpus) REFERENCES ad_vector_indexes(corpus));
        CREATE TABLE IF NOT EXISTS ad_vector_chunks(
          corpus TEXT NOT NULL, namespace TEXT NOT NULL, source_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
          payload TEXT NOT NULL, PRIMARY KEY(corpus, namespace, chunk_id),
          FOREIGN KEY(corpus, namespace, source_id) REFERENCES ad_vector_documents(corpus, namespace, source_id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS ad_vector_source ON ad_vector_chunks(corpus, namespace, source_id, chunk_id);
        PRAGMA user_version=1;`);
      return new SqliteVectorStore(db, limits);
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

function privateFile(stat: { mode: number; uid: number }): boolean {
  // Windows privacy follows the host directory's inherited ACL; POSIX mode bits are not an ACL verifier.
  return (
    process.platform === "win32" ||
    ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.())
  );
}
