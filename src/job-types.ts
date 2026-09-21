import { z } from "zod";
import { RunRequestSchema, type RunEvent } from "./types.js";

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
export const JobOperationSchema = z.enum(["submit", "read", "cancel"]);
export type JobOperation = z.infer<typeof JobOperationSchema>;
export const JobSubmitSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
    request: RunRequestSchema,
  })
  .strict();
export type JobSubmit = z.infer<typeof JobSubmitSchema>;
export const JobIdentitySchema = z.object({ id: uuid }).strict();
export type JobIdentity = z.infer<typeof JobIdentitySchema>;
export const JobEventsRequestSchema = JobIdentitySchema.extend({
  after: count,
  limit: z.number().int().min(1).max(100).optional(),
});
export type JobEventsRequest = z.infer<typeof JobEventsRequestSchema>;
export const JobInfoSchema = z
  .object({
    id: uuid,
    runId: uuid,
    provider: z.string().min(1),
    model: z.string().min(1),
    state: z.enum([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    cursor: count,
    cancelRequested: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp.optional(),
  })
  .refine((job) => {
    const terminal = job.state !== "queued" && job.state !== "running";
    return (
      terminal === (job.expiresAt !== undefined) &&
      job.updatedAt >= job.createdAt &&
      (!job.expiresAt || job.expiresAt > job.updatedAt) &&
      (job.state !== "queued" || job.cursor === 0) &&
      (!terminal || job.cursor >= 2)
    );
  });
export type JobInfo = z.infer<typeof JobInfoSchema>;
/** Polling is observation only. Receipts never dispatch or re-execute tools. */
export interface JobEventPage {
  job: JobInfo;
  events: RunEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export const JobStoreOptionsSchema = z
  .object({
    /** Payload lifetime after a terminal state; not a job execution deadline. */
    retentionMs: z.number().int().min(1).max(31_536_000_000),
    maxJobs: z.number().int().min(1).max(100_000).default(1000),
    maxJobsPerSubject: z.number().int().min(1).max(100_000).default(100),
    maxBytes: z
      .number()
      .int()
      .min(65_536)
      .max(Number.MAX_SAFE_INTEGER)
      .default(64_000_000),
    maxJobBytes: z
      .number()
      .int()
      .min(16_384)
      .max(64_000_000)
      .default(8_000_000),
  })
  .strict();
export type JobStoreOptions = z.input<typeof JobStoreOptionsSchema>;
export const JobWorkerOptionsSchema = z
  .object({
    /** Ownership lease only. Renewal never counts as model/tool progress. */
    leaseMs: z.number().int().min(300).max(3_600_000).default(30_000),
    pollIntervalMs: z.number().int().min(10).max(60_000).default(250),
    maxWorkers: z.number().int().min(1).max(1000).default(32),
  })
  .strict();
export type JobWorkerOptions = z.input<typeof JobWorkerOptionsSchema>;
