import type { JobInfo } from "./job-types.js";
import type { ErrorInfo, RunEvent, RunRequest } from "./types.js";

/** Private persistence record. Never return credentials, requests or scope snapshots in status responses. */
export interface JobRecord {
  schema: "agenticdriver.job.v1";
  info: JobInfo;
  subject: string;
  keyHash: string;
  fingerprint: string;
  /** Stable, host-authorized identity; the HTTP host stores a token digest, never a bearer token. */
  principal: string;
  account: { hostId: string; accountId: string };
  request: RunRequest;
  events: RunEvent[];
  retentionMs: number;
}
export type NewJob = Omit<
  JobRecord,
  "schema" | "info" | "events" | "retentionMs"
>;

/**
 * Trusted host extension. Every mutation must be atomic and durable before acknowledgement.
 * One renewable, fenced worker owns a store. Expired/released ownership interrupts running
 * work; it must NEVER return that work to queued. Queued work may start under a new owner.
 * Accepted (subject, keyHash) ownership survives payload retention as a tombstone.
 */
export interface JobStore {
  close?(): Promise<void>;
  acquire(owner: string, leaseMs: number): Promise<void>;
  renew(owner: string, leaseMs: number): Promise<void>;
  release(owner: string): Promise<void>;
  submit(job: NewJob): Promise<JobRecord>;
  read(subject: string, id: string): Promise<JobRecord>;
  queued(owner: string): Promise<JobRecord[]>;
  start(owner: string, id: string): Promise<boolean>;
  append(owner: string, id: string, event: RunEvent): Promise<void>;
  /** Fail before dispatch, or mark an already-started job interrupted/uncertain. */
  fail(owner: string, id: string, error: ErrorInfo): Promise<void>;
  cancel(subject: string, id: string): Promise<JobRecord>;
}
