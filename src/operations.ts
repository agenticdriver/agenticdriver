import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DriverError } from "./errors.js";
import type { RunEvent, RunRequest } from "./types.js";

export interface OperationRecord {
  schema: "agenticdriver.operation.v1";
  fingerprint: string;
  runId: string;
  provider: string;
  model: string;
  state: "running" | "completed" | "failed" | "cancelled" | "uncertain";
  /** Compact recovery log: text/progress deltas are not persisted. */
  events: RunEvent[];
  updatedAt: string;
}
export interface OperationWriter {
  append(event: RunEvent): Promise<void>;
  interrupt(): Promise<void>;
}
export type OperationClaim =
  | { created: true; record: OperationRecord; writer: OperationWriter }
  | { created: false; record: OperationRecord };
/** Implementations must atomically claim (subject, key), commit before acknowledging, and never evict accepted keys silently. */
export interface OperationStore {
  claim(
    subject: string,
    key: string,
    proposed: OperationRecord,
  ): Promise<OperationClaim>;
}

export function operationKey(subject: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify([subject, key]))
    .digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function newOperation(
  request: RunRequest,
  runId: string,
): OperationRecord {
  return {
    schema: "agenticdriver.operation.v1",
    fingerprint: createHash("sha256").update(canonical(request)).digest("hex"),
    runId,
    provider: request.provider,
    model: request.model,
    state: "running",
    events: [],
    updatedAt: new Date().toISOString(),
  };
}
function storeError(): DriverError {
  return new DriverError(
    "OPERATION_STORE_ERROR",
    "The operation record could not be read or committed. Its outcome may be uncertain; do not replay it with a new key.",
    false,
    "uncertain",
  );
}
function encoded(record: OperationRecord, maxBytes: number): string {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > maxBytes)
    throw new DriverError(
      "OPERATION_RECORD_LIMIT",
      "The recovery record reached its size limit. The accepted operation will not be replayed automatically.",
      false,
      "uncertain",
    );
  return json;
}
function writer(
  initial: OperationRecord,
  save: (record: OperationRecord) => Promise<void>,
): OperationWriter {
  let current = initial;
  return {
    async append(event) {
      if (event.type === "text.delta" || event.type === "run.progress") return;
      const next = structuredClone(current);
      next.events.push(structuredClone(event));
      next.updatedAt = new Date().toISOString();
      if (event.type === "run.completed") next.state = "completed";
      else if (event.type === "run.failed") next.state = "failed";
      else if (event.type === "run.cancelled") next.state = "cancelled";
      await save(next);
      current = next;
    },
    async interrupt() {
      if (current.state !== "running") return;
      const next = {
        ...current,
        state: "uncertain" as const,
        updatedAt: new Date().toISOString(),
      };
      await save(next);
      current = next;
    },
  };
}
function validateLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
}

/** Process-lifetime deduplication for embedded/test applications. Never silently evicts keys. */
export class MemoryOperationStore implements OperationStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly maxEntries: number;
  private readonly maxRecordBytes: number;
  constructor(options: { maxEntries?: number; maxRecordBytes?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxRecordBytes = options.maxRecordBytes ?? 8_000_000;
    validateLimit(this.maxEntries, "maxEntries");
    validateLimit(this.maxRecordBytes, "maxRecordBytes");
  }
  async claim(
    subject: string,
    key: string,
    proposed: OperationRecord,
  ): Promise<OperationClaim> {
    const id = operationKey(subject, key),
      existing = this.records.get(id);
    if (existing) return { created: false, record: structuredClone(existing) };
    if (this.records.size >= this.maxEntries)
      throw new DriverError(
        "OPERATION_STORE_FULL",
        "The operation store is full. Accepted keys have been retained; no new operation was started.",
      );
    encoded(proposed, this.maxRecordBytes);
    const record = structuredClone(proposed);
    this.records.set(id, record);
    return {
      created: true,
      record: structuredClone(record),
      writer: writer(record, async (next) => {
        encoded(next, this.maxRecordBytes);
        this.records.set(id, structuredClone(next));
      }),
    };
  }
}

/** Durable, immutable key ownership on a local filesystem. Multiple processes share atomic hard-link claims. */
export class FileOperationStore implements OperationStore {
  private readonly maxRecordBytes: number;
  private ready?: Promise<void>;
  constructor(
    private readonly directory: string,
    options: { maxRecordBytes?: number } = {},
  ) {
    if (!isAbsolute(directory))
      throw new Error("Operation storage requires an absolute directory.");
    this.maxRecordBytes = options.maxRecordBytes ?? 8_000_000;
    validateLimit(this.maxRecordBytes, "maxRecordBytes");
  }
  private initialize() {
    return (this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await stat(this.directory);
      if (
        !info.isDirectory() ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error(
          "Operation directory must be private to the host account.",
        );
    })());
  }
  private async syncDirectory() {
    // Windows has no equivalent of POSIX directory fsync via this API.
    if (process.platform === "win32") return;
    const handle = await open(this.directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async temporary(record: OperationRecord): Promise<string> {
    const json = encoded(record, this.maxRecordBytes);
    const path = join(this.directory, `.pending-${randomUUID()}`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(json);
      await handle.sync();
    } catch (error) {
      await rm(path, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
    return path;
  }
  private async load(path: string): Promise<OperationRecord> {
    const handle = await open(path, "r");
    try {
      if ((await handle.stat()).size > this.maxRecordBytes) throw storeError();
      const record = JSON.parse(
        await handle.readFile("utf8"),
      ) as OperationRecord;
      if (
        record.schema !== "agenticdriver.operation.v1" ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
        typeof record.runId !== "string" ||
        typeof record.provider !== "string" ||
        typeof record.model !== "string" ||
        !["running", "completed", "failed", "cancelled", "uncertain"].includes(
          record.state,
        ) ||
        !Array.isArray(record.events) ||
        !record.events.every(
          (event) =>
            event &&
            event.runId === record.runId &&
            typeof event.type === "string",
        )
      )
        throw storeError();
      return record;
    } finally {
      await handle.close();
    }
  }
  async claim(
    subject: string,
    key: string,
    proposed: OperationRecord,
  ): Promise<OperationClaim> {
    let pending: string | undefined;
    try {
      await this.initialize();
      const path = join(this.directory, operationKey(subject, key) + ".json");
      // Recover existing outcomes even when no free space remains for another claim file.
      try {
        return { created: false, record: await this.load(path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      pending = await this.temporary(proposed);
      try {
        await link(pending, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return { created: false, record: await this.load(path) };
      }
      await this.syncDirectory();
      return {
        created: true,
        record: structuredClone(proposed),
        writer: writer(structuredClone(proposed), async (next) => {
          let temp: string | undefined;
          try {
            temp = await this.temporary(next);
            await rename(temp, path);
            await this.syncDirectory();
          } catch (error) {
            if (error instanceof DriverError) throw error;
            throw storeError();
          } finally {
            if (temp) await rm(temp, { force: true }).catch(() => {});
          }
        }),
      };
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw storeError();
    } finally {
      if (pending) await rm(pending, { force: true }).catch(() => {});
    }
  }
}

/** Replays recorded outcomes, not model/tool execution. Wire sequences are compact and contiguous. */
export function recoveryEvents(record: OperationRecord): RunEvent[] {
  // Historical approvals are audit records, never new permission requests.
  const events = structuredClone(record.events).filter(
    (event) =>
      event.type !== "approval.requested" &&
      event.type !== "approval.resolved" &&
      event.type !== "tool.execution.requested",
  );
  if (events[0]?.type !== "run.started")
    events.unshift({
      type: "run.started",
      runId: record.runId,
      provider: record.provider,
      model: record.model,
      sequence: 1,
      timestamp: record.updatedAt,
    });
  if (record.state === "running" || record.state === "uncertain")
    events.push({
      type: "run.failed",
      runId: record.runId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      error: new DriverError(
        "OPERATION_UNCERTAIN",
        "This operation was accepted but its terminal outcome was not recorded. Inspect recorded tool outcomes and reconcile external effects before creating any replacement operation.",
        false,
        "uncertain",
      ).toJSON(),
    });
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}
