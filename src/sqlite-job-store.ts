import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DriverError } from "./errors.js";
import { JobStoreOptionsSchema, type JobStoreOptions } from "./job-types.js";
import type { JobStore, JobRecord, NewJob } from "./job-store.js";
import type { ErrorInfo, RunEvent } from "./types.js";

const interruption = new DriverError(
  "JOB_INTERRUPTED",
  "Execution ownership ended after this job started. Reconcile its recorded effects in the application; the host will not execute it again.",
  false,
  "uncertain",
).toJSON();
const terminal = (state: string) => state !== "queued" && state !== "running";
const privateFile = (stat: { mode: number; uid: number }) =>
  process.platform === "win32" ||
  ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());

/** Local, single-worker durable queue. SQLite transactions fence competing host processes. */
export class SqliteJobStore implements JobStore {
  private closed = false;
  private constructor(
    private readonly db: DatabaseSync,
    private readonly options: ReturnType<typeof JobStoreOptionsSchema.parse>,
  ) {}

  static async open(
    path: string,
    input: JobStoreOptions,
  ): Promise<SqliteJobStore> {
    const parsed = JobStoreOptionsSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_JOB_CONFIG",
        "Configure job retention and positive bounded storage capacities.",
      );
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
        "JOB_STORAGE_UNSAFE",
        "Use a private, host-owned directory for the job database.",
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
          "JOB_STORAGE_UNSAFE",
          "The job database must be a private regular file with one link.",
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
          "JOB_STORAGE_UNSAFE",
          "Job database sidecars must be private regular files.",
        );
    }
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new DriverError(
        "SQLITE_UNAVAILABLE",
        "The SQLite job store requires Node 22.13 or later.",
      );
    }
    const db = new sqlite.DatabaseSync(canonical);
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (
        tables.length &&
        (db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
          tables.length !== 2 ||
          !tables.every((row) =>
            ["ad_jobs", "ad_job_worker"].includes(String(row.name)),
          ))
      )
        throw new DriverError(
          "JOB_STORAGE_MISMATCH",
          "Use a dedicated AgenticDriver job database; automatic migrations are not enabled.",
        );
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS ad_jobs (
          id TEXT PRIMARY KEY, subject TEXT NOT NULL, key_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER,
          payload TEXT, bytes INTEGER NOT NULL, reserved INTEGER NOT NULL,
          UNIQUE(subject, key_hash));
        CREATE TABLE IF NOT EXISTS ad_job_worker (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
      return new SqliteJobStore(db, parsed.data);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(work: (now: number) => T): T {
    if (this.closed)
      throw new DriverError("JOB_STORE_CLOSED", "The job store is closed.");
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const now = Date.now();
      this.maintain(now);
      // Retention/recovery must remain committed even when the requested lookup
      // returns JOB_EXPIRED or a stale worker's write is rejected.
      this.db.exec("SAVEPOINT job_operation");
      let value: T;
      try {
        value = work(now);
      } catch (error) {
        this.db.exec(
          "ROLLBACK TO job_operation; RELEASE job_operation; COMMIT",
        );
        began = false;
        throw error;
      }
      this.db.exec("RELEASE job_operation");
      this.db.exec("COMMIT");
      began = false;
      return value;
    } catch (error) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* Keep the fixed storage error below. */
        }
      }
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "JOB_STORE_ERROR",
        "Job storage did not acknowledge the operation. Reconcile the existing job key before submitting replacement work.",
        false,
        "uncertain",
      );
    }
  }
  private maintain(now: number) {
    const lease = this.db
      .prepare("SELECT expires_at FROM ad_job_worker WHERE id=1")
      .get();
    if (lease && Number(lease.expires_at) <= now) {
      this.interruptRunning(now);
      this.db.exec("DELETE FROM ad_job_worker");
    }
    // Keep key ownership after erasing sensitive payloads. Tombstones count toward capacity.
    this.db
      .prepare(
        "UPDATE ad_jobs SET payload=NULL, bytes=0, reserved=0 WHERE expires_at<=? AND payload IS NOT NULL",
      )
      .run(now);
  }
  private interruptRunning(now: number) {
    for (const row of this.db
      .prepare("SELECT payload FROM ad_jobs WHERE state='running'")
      .all()) {
      const record = this.decode(row.payload);
      this.end(record, "interrupted", interruption, now);
    }
  }
  private lease(owner: string) {
    const current = this.db
      .prepare("SELECT owner,expires_at FROM ad_job_worker WHERE id=1")
      .get();
    if (current?.owner !== owner || Number(current.expires_at) <= Date.now())
      throw new DriverError(
        "JOB_LEASE_LOST",
        "This worker no longer owns execution. Started jobs cannot be replayed automatically.",
        false,
        "uncertain",
      );
  }
  private decode(payload: unknown): JobRecord {
    if (payload === null || payload === undefined)
      throw new DriverError(
        "JOB_EXPIRED",
        "The job payload expired. Its accepted key is retained and will not start new execution.",
      );
    const record = JSON.parse(String(payload)) as JobRecord;
    if (
      record.schema !== "agenticdriver.job.v1" ||
      !record.info ||
      !Array.isArray(record.events)
    )
      throw new DriverError(
        "JOB_STORE_ERROR",
        "The stored job record is invalid.",
        false,
        "uncertain",
      );
    return record;
  }
  private get(id: string, subject?: string): JobRecord {
    const row =
      subject === undefined
        ? this.db.prepare("SELECT payload FROM ad_jobs WHERE id=?").get(id)
        : this.db
            .prepare("SELECT payload FROM ad_jobs WHERE id=? AND subject=?")
            .get(id, subject);
    if (!row)
      throw new DriverError(
        "JOB_NOT_FOUND",
        "The job is unavailable to this subject.",
      );
    return this.decode(row.payload);
  }
  private save(record: JobRecord, emergency = false) {
    const payload = JSON.stringify(record),
      bytes = Buffer.byteLength(payload);
    const reserved = terminal(record.info.state) ? 0 : 4096;
    const old = this.db
      .prepare("SELECT bytes,reserved FROM ad_jobs WHERE id=?")
      .get(record.info.id);
    const total = Number(
      this.db
        .prepare("SELECT COALESCE(SUM(bytes+reserved),0) AS n FROM ad_jobs")
        .get()!.n,
    );
    if (
      !emergency &&
      (bytes + reserved > this.options.maxJobBytes ||
        total -
          Number(old?.bytes ?? 0) -
          Number(old?.reserved ?? 0) +
          bytes +
          reserved >
          this.options.maxBytes)
    )
      throw new DriverError(
        "JOB_RECORD_LIMIT",
        "The durable event log reached its configured size limit. Reconcile the job; its execution will not be repeated.",
        false,
        "uncertain",
      );
    this.db
      .prepare(
        `INSERT INTO ad_jobs(id,subject,key_hash,fingerprint,state,expires_at,payload,bytes,reserved)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,payload=excluded.payload,bytes=excluded.bytes,reserved=excluded.reserved`,
      )
      .run(
        record.info.id,
        record.subject,
        record.keyHash,
        record.fingerprint,
        record.info.state,
        record.info.expiresAt ? Date.parse(record.info.expiresAt) : null,
        payload,
        bytes,
        reserved,
      );
  }
  private end(
    record: JobRecord,
    state: "failed" | "cancelled" | "interrupted",
    error: ErrorInfo,
    now: number,
  ) {
    const timestamp = new Date(
      Math.max(now, Date.parse(record.info.updatedAt)),
    ).toISOString();
    if (!record.events.length)
      record.events.push({
        type: "run.started",
        runId: record.info.runId,
        sequence: 1,
        timestamp,
        provider: record.info.provider,
        model: record.info.model,
      });
    record.events.push({
      type: state === "cancelled" ? "run.cancelled" : "run.failed",
      runId: record.info.runId,
      sequence: record.events.length + 1,
      timestamp,
      error,
    });
    record.info = {
      ...record.info,
      state,
      cursor: record.events.length,
      updatedAt: timestamp,
      expiresAt: new Date(
        Date.parse(timestamp) + record.retentionMs,
      ).toISOString(),
    };
    // A reserved 4KiB per live job guarantees room for a fixed, redacted terminal barrier.
    this.save(record, true);
  }

  async acquire(owner: string, leaseMs: number) {
    this.transaction((now) => {
      if (this.db.prepare("SELECT owner FROM ad_job_worker WHERE id=1").get())
        throw new DriverError(
          "JOB_WORKER_BUSY",
          "A live worker already owns this job store.",
          true,
        );
      this.db
        .prepare("INSERT INTO ad_job_worker VALUES(1,?,?)")
        .run(owner, now + leaseMs);
    });
  }
  async renew(owner: string, leaseMs: number) {
    this.transaction((now) => {
      this.lease(owner);
      this.db
        .prepare("UPDATE ad_job_worker SET expires_at=? WHERE id=1")
        .run(now + leaseMs);
    });
  }
  async release(owner: string) {
    this.transaction((now) => {
      this.lease(owner);
      this.interruptRunning(now);
      this.db.exec("DELETE FROM ad_job_worker");
    });
  }
  async submit(input: NewJob): Promise<JobRecord> {
    return this.transaction((now) => {
      const row = this.db
        .prepare(
          "SELECT fingerprint,payload FROM ad_jobs WHERE subject=? AND key_hash=?",
        )
        .get(input.subject, input.keyHash);
      if (row) {
        if (row.fingerprint !== input.fingerprint)
          throw new DriverError(
            "IDEMPOTENCY_CONFLICT",
            "This job key was accepted with a different request.",
          );
        return this.decode(row.payload);
      }
      const count = Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM ad_jobs").get()!.n,
      );
      const subjectCount = Number(
        this.db
          .prepare("SELECT COUNT(*) AS n FROM ad_jobs WHERE subject=?")
          .get(input.subject)!.n,
      );
      if (
        count >= this.options.maxJobs ||
        subjectCount >= this.options.maxJobsPerSubject
      )
        throw new DriverError(
          "JOB_STORE_FULL",
          "The configured job or subject capacity is full. Accepted keys have been retained; no new job was accepted.",
        );
      const timestamp = new Date(now).toISOString();
      const record: JobRecord = {
        ...structuredClone(input),
        schema: "agenticdriver.job.v1",
        events: [],
        retentionMs: this.options.retentionMs,
        info: {
          id: randomUUID(),
          runId: randomUUID(),
          provider: input.request.provider,
          model: input.request.model,
          state: "queued",
          cursor: 0,
          cancelRequested: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
      this.save(record);
      return record;
    });
  }
  async read(subject: string, id: string) {
    return this.transaction(() => this.get(id, subject));
  }
  async queued(owner: string) {
    return this.transaction(() => {
      this.lease(owner);
      return this.db
        .prepare(
          "SELECT payload FROM ad_jobs WHERE state='queued' ORDER BY rowid",
        )
        .all()
        .map((row) => this.decode(row.payload));
    });
  }
  async start(owner: string, id: string) {
    return this.transaction((now) => {
      this.lease(owner);
      const record = this.get(id);
      if (record.info.state !== "queued") return false;
      record.info.state = "running";
      record.info.updatedAt = new Date(
        Math.max(now, Date.parse(record.info.updatedAt)),
      ).toISOString();
      this.save(record);
      return true;
    });
  }
  async append(owner: string, id: string, event: RunEvent) {
    this.transaction((now) => {
      this.lease(owner);
      const record = this.get(id);
      if (Buffer.byteLength(JSON.stringify(event)) > 1_500_000)
        throw new DriverError(
          "JOB_RECORD_LIMIT",
          "A durable job event exceeded 1,500,000 UTF-8 JSON bytes. Reconcile the interrupted job.",
          false,
          "uncertain",
        );
      if (
        record.info.state !== "running" ||
        event.runId !== record.info.runId ||
        event.sequence !== record.events.length + 1 ||
        (event.sequence === 1 && event.type !== "run.started")
      )
        throw new DriverError(
          "JOB_EVENT_CONFLICT",
          "This worker cannot append the event to the recorded job.",
          false,
          "uncertain",
        );
      record.events.push(structuredClone(event));
      record.info.cursor = event.sequence;
      record.info.updatedAt = new Date(
        Math.max(now, Date.parse(record.info.updatedAt)),
      ).toISOString();
      if (
        ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
      ) {
        record.info.state =
          event.type === "run.completed"
            ? "completed"
            : event.type === "run.cancelled"
              ? "cancelled"
              : "failed";
        record.info.expiresAt = new Date(
          Date.parse(record.info.updatedAt) + record.retentionMs,
        ).toISOString();
      }
      this.save(record);
    });
  }
  async fail(owner: string, id: string, error: ErrorInfo) {
    this.transaction((now) => {
      this.lease(owner);
      const record = this.get(id);
      if (terminal(record.info.state)) return;
      this.end(
        record,
        record.info.state === "running" ? "interrupted" : "failed",
        record.info.state === "running"
          ? interruption
          : {
              code: error.code.slice(0, 80),
              message:
                "The queued job no longer satisfies its configured execution policy. Inspect host configuration; no replacement run was started.",
              retryable: false,
            },
        now,
      );
    });
  }
  async cancel(subject: string, id: string) {
    return this.transaction((now) => {
      const record = this.get(id, subject);
      if (terminal(record.info.state)) return record;
      record.info.cancelRequested = true;
      if (record.info.state === "queued")
        this.end(
          record,
          "cancelled",
          new DriverError(
            "CANCELLED",
            "The queued job was cancelled before dispatch.",
          ).toJSON(),
          now,
        );
      else {
        record.info.updatedAt = new Date(
          Math.max(now, Date.parse(record.info.updatedAt)),
        ).toISOString();
        this.save(record);
      }
      return record;
    });
  }
  /** Stop the JobService before closing its store. Abrupt closure leaves lease-based recovery. */
  async close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
