import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DriverError } from "./errors.js";
import { JobStoreOptionsSchema, type JobStoreOptions } from "./job-types.js";
import { openJobDatabase, jobGeneration } from "./job-database.js";
import type {
  JobStoreInspection,
  JobStore,
  JobRecord,
  NewJob,
} from "./job-store.js";
import type { ErrorInfo, RunEvent } from "./types.js";

const interruption = new DriverError(
  "JOB_INTERRUPTED",
  "Execution ownership ended after this job started. Reconcile its recorded effects in the application; the host will not execute it again.",
  false,
  "uncertain",
).toJSON();
const terminal = (state: string) => state !== "queued" && state !== "running";

/** Local, single-worker durable queue. SQLite transactions fence competing host processes. */
export class SqliteJobStore implements JobStore {
  private closed = false;
  private owner?: string;
  private acquired = false;
  private constructor(
    private readonly db: DatabaseSync,
    private readonly options: ReturnType<typeof JobStoreOptionsSchema.parse>,
    private readonly location: { path: string; identity: string },
    private generation: number,
  ) {}

  static async open(
    path: string,
    input: JobStoreOptions,
  ): Promise<SqliteJobStore> {
    return SqliteJobStore.load(path, input, "initialize");
  }
  /** Open an existing store without creating its file or schema. */
  static async openExisting(
    path: string,
    input: JobStoreOptions,
  ): Promise<SqliteJobStore> {
    return SqliteJobStore.load(path, input, "existing");
  }
  private static async load(
    path: string,
    input: JobStoreOptions,
    mode: "initialize" | "existing",
  ): Promise<SqliteJobStore> {
    const parsed = JobStoreOptionsSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_JOB_CONFIG",
        "Configure job retention and positive bounded storage capacities.",
      );
    const opened = await openJobDatabase(path, mode);
    return new SqliteJobStore(
      opened.db,
      parsed.data,
      opened,
      opened.generation,
    );
  }

  /** Observe logical state without initializing a database, expiring payloads or recovering leases.
   * SQLite may create/update WAL coordination files; this is not filesystem-immutable access.
   * The digest describes this snapshot, not a lock or a durable change counter.
   */
  static async inspect(path: string): Promise<JobStoreInspection> {
    const { db, identity } = await openJobDatabase(path, "read");
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
      const observation = SqliteJobStore.observation(db, identity);
      db.exec("COMMIT");
      return observation;
    } finally {
      db.close();
    }
  }

  private static observation(
    db: DatabaseSync,
    identity: string,
  ): JobStoreInspection {
    const jobs = db.prepare("SELECT * FROM ad_jobs ORDER BY id").all();
    const leases = db.prepare("SELECT * FROM ad_job_worker ORDER BY id").all();
    const states = new Map<string, number>();
    const blockers = new Set<JobStoreInspection["blockers"][number]>();
    if (leases.length) blockers.add("lease");
    for (const job of jobs) {
      const state = String(job.state);
      states.set(state, (states.get(state) ?? 0) + 1);
      if (state === "queued" || state === "running") blockers.add("pending");
      else if (state !== "completed" && state !== "cancelled")
        blockers.add("unreconciled");
      if (job.payload === null) {
        if (job.handoff_safe !== 1) blockers.add("unclassified");
        continue;
      }
      try {
        const record = JSON.parse(String(job.payload)) as JobRecord;
        if (
          record.schema !== "agenticdriver.job.v1" ||
          record.info?.id !== job.id ||
          record.info.state !== state ||
          !Array.isArray(record.events)
        ) {
          blockers.add("unclassified");
        } else if (
          record.events.some(
            (event) =>
              (event.type === "run.failed" || event.type === "run.cancelled") &&
              event.error.outcome === "uncertain",
          )
        ) {
          blockers.add("unreconciled");
        }
      } catch {
        blockers.add("unclassified");
      }
    }
    const generation = jobGeneration(db);
    const snapshot = createHash("sha256")
      .update(JSON.stringify({ identity, generation, jobs, leases }))
      .digest("hex");
    return {
      snapshot,
      acceptedKeys: jobs.length,
      states: Object.fromEntries(states),
      lease:
        leases.length === 0
          ? "none"
          : leases.some((row) => Number(row.expires_at) > Date.now())
            ? "active"
            : "expired",
      blockers: [...blockers].sort(),
      quiet: blockers.size === 0,
    };
  }

  private transaction<T>(
    work: (now: number) => T,
    mode: "ordinary" | "acquire" | "handoff" = "ordinary",
  ): T {
    if (this.closed)
      throw new DriverError("JOB_STORE_CLOSED", "The job store is closed.");
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const now = Date.now();
      const generation = jobGeneration(this.db);
      if (generation !== this.generation) this.lost();
      if (generation > 0 && mode === "ordinary") this.lease(this.owner ?? "");
      if (generation > 0 && mode === "acquire") {
        const lease = this.db
          .prepare("SELECT expires_at FROM ad_job_worker WHERE id=1")
          .get();
        if (lease && Number(lease.expires_at) > now)
          throw new DriverError(
            "JOB_WORKER_BUSY",
            "A live worker already owns this job store.",
            true,
          );
      }
      if (mode !== "handoff") this.maintain(now);
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
    if (jobGeneration(this.db) > 0) {
      const safe =
        ["completed", "cancelled"].includes(record.info.state) &&
        !record.events.some(
          (event) =>
            (event.type === "run.failed" || event.type === "run.cancelled") &&
            event.error.outcome === "uncertain",
        );
      this.db
        .prepare("UPDATE ad_jobs SET handoff_safe=? WHERE id=?")
        .run(safe ? 1 : 0, record.info.id);
    }
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

  private lost(): never {
    throw new DriverError(
      "JOB_LEASE_LOST",
      "This handle no longer owns execution. Open a new handle to reconcile ownership.",
      false,
      "uncertain",
    );
  }
  private checkOwner(owner: string) {
    if (this.generation > 0 && owner !== this.owner) this.lost();
  }
  private advanceGeneration() {
    if (jobGeneration(this.db) > 0)
      this.db.exec(
        "UPDATE ad_job_generation SET generation=generation+1 WHERE id=1",
      );
    return jobGeneration(this.db);
  }
  async acquire(owner: string, leaseMs: number) {
    if (this.generation > 0 && this.acquired) this.lost();
    const generation = this.transaction((now) => {
      if (this.db.prepare("SELECT owner FROM ad_job_worker WHERE id=1").get())
        throw new DriverError(
          "JOB_WORKER_BUSY",
          "A live worker already owns this job store.",
          true,
        );
      const next = this.advanceGeneration();
      this.db
        .prepare("INSERT INTO ad_job_worker VALUES(1,?,?)")
        .run(owner, now + leaseMs);
      return next;
    }, "acquire");
    this.generation = generation;
    this.owner = owner;
    this.acquired = true;
  }
  async acquireQuiet(
    owner: string,
    leaseMs: number,
    snapshot: string,
  ): Promise<SqliteJobStore> {
    if (
      !owner ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1 ||
      !/^[a-f0-9]{64}$/.test(snapshot)
    )
      throw new DriverError(
        "INVALID_JOB_HANDOFF",
        "Supply an owner, positive lease duration and inspection snapshot.",
      );
    const opened = await openJobDatabase(this.location.path, "existing");
    const bound = new SqliteJobStore(
      opened.db,
      this.options,
      opened,
      opened.generation,
    );
    try {
      if (opened.identity !== this.location.identity)
        throw new DriverError(
          "JOB_STORAGE_MISMATCH",
          "The original job database identity changed.",
        );
      const generation = this.transaction((now) => {
        const observed = SqliteJobStore.observation(
          this.db,
          this.location.identity,
        );
        if (observed.snapshot !== snapshot)
          throw new DriverError(
            "JOB_HANDOFF_CHANGED",
            "Job storage changed after inspection. Inspect and reconcile again.",
          );
        if (!observed.quiet)
          throw new DriverError(
            "JOB_HANDOFF_BLOCKED",
            "Job storage requires reconciliation before adoption.",
          );
        if (this.generation === 0) {
          this.db
            .exec(`ALTER TABLE ad_jobs ADD COLUMN handoff_safe INTEGER NOT NULL DEFAULT 0;
            UPDATE ad_jobs SET handoff_safe=1;
            CREATE TABLE ad_job_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
            INSERT INTO ad_job_generation VALUES(1,1); PRAGMA user_version=2;`);
        } else this.advanceGeneration();
        this.db
          .prepare("INSERT INTO ad_job_worker VALUES(1,?,?)")
          .run(owner, now + leaseMs);
        return jobGeneration(this.db);
      }, "handoff");
      bound.generation = generation;
      bound.owner = owner;
      bound.acquired = true;
      return bound;
    } catch (error) {
      await bound.close();
      throw error;
    }
  }
  async renew(owner: string, leaseMs: number) {
    this.checkOwner(owner);
    this.transaction((now) => {
      this.lease(owner);
      this.db
        .prepare("UPDATE ad_job_worker SET expires_at=? WHERE id=1")
        .run(now + leaseMs);
    });
  }
  async release(owner: string) {
    this.checkOwner(owner);
    this.transaction((now) => {
      this.lease(owner);
      this.interruptRunning(now);
      this.db.exec("DELETE FROM ad_job_worker");
      this.advanceGeneration();
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
    this.checkOwner(owner);
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
    this.checkOwner(owner);
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
    this.checkOwner(owner);
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
    this.checkOwner(owner);
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
