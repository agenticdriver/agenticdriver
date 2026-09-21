import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgenticDriver } from "./driver.js";
import { abortable, DriverError, publicError } from "./errors.js";
import { FairScheduler, type AdmissionTicket } from "./scheduling.js";
import { newOperation, operationKey } from "./operations.js";
import {
  JobEventsRequestSchema,
  JobIdentitySchema,
  JobOperationSchema,
  JobSubmitSchema,
  JobWorkerOptionsSchema,
  type JobEventPage,
  type JobEventsRequest,
  type JobIdentity,
  type JobInfo,
  type JobOperation,
  type JobSubmit,
  type JobWorkerOptions,
} from "./job-types.js";
import type { JobStore, JobRecord } from "./job-store.js";
import type { RunRequest } from "./types.js";
export * from "./job-types.js";
export type * from "./job-store.js";
export { SqliteJobStore } from "./sqlite-job-store.js";

const principalSchema = z.object({
  subject: z.string().min(1).max(128),
  providers: z.array(z.string()),
  tools: z.array(z.string()).default([]),
  jobs: z.array(JobOperationSchema),
  retrieval: z.array(z.string()).default([]),
});
export type JobPrincipal = z.input<typeof principalSchema>;
export interface JobServiceOptions extends JobWorkerOptions {
  store: JobStore;
  /** Resolve current authority at every API call and again before dispatch after restart. */
  resolvePrincipal(
    id: string,
  ): JobPrincipal | undefined | Promise<JobPrincipal | undefined>;
  /** Share host admission with foreground runs. Defaults to the driver's scheduler or standard caps. */
  scheduler?: FairScheduler;
  onError?(error: unknown): void;
}

/** Explicit detached execution. This service owns no application checkpoints or canonical domain state. */
export class JobService {
  private readonly owner = randomUUID();
  private readonly controller = new AbortController();
  private readonly active = new Map<
    string,
    { record: JobRecord; controller: AbortController; pending: Promise<void> }
  >();
  private readonly worker: ReturnType<typeof JobWorkerOptionsSchema.parse>;
  private readonly scheduler: FairScheduler;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pumping?: Promise<void>;
  private lastCandidate?: string;
  private renewing?: Promise<void>;
  private closing?: Promise<void>;
  private constructor(
    private readonly driver: AgenticDriver,
    private readonly options: JobServiceOptions,
  ) {
    const parsed = JobWorkerOptionsSchema.safeParse({
      leaseMs: options.leaseMs,
      pollIntervalMs: options.pollIntervalMs,
      maxWorkers: options.maxWorkers,
    });
    if (!parsed.success || typeof options.resolvePrincipal !== "function")
      throw new DriverError(
        "INVALID_JOB_CONFIG",
        "Configure a current principal resolver and bounded worker settings.",
      );
    this.worker = parsed.data;
    this.scheduler =
      options.scheduler ?? driver.scheduler ?? new FairScheduler();
  }
  static async open(
    driver: AgenticDriver,
    options: JobServiceOptions,
  ): Promise<JobService> {
    const service = new JobService(driver, options);
    await options.store.acquire(service.owner, service.worker.leaseMs);
    service.timer = setInterval(
      () => service.kick(),
      service.worker.pollIntervalMs,
    );
    service.heartbeat = setInterval(
      () => service.renew(),
      Math.floor(service.worker.leaseMs / 3),
    );
    service.timer.unref();
    service.heartbeat.unref();
    service.kick();
    return service;
  }
  private assertOpen() {
    if (this.controller.signal.aborted)
      throw new DriverError(
        "JOBS_UNAVAILABLE",
        "The durable job worker is stopped. Reconnect to its replacement host to inspect accepted work.",
      );
  }
  private async principal(
    id: string,
    operation: JobOperation,
    expectedSubject?: string,
  ) {
    const parsed = principalSchema.safeParse(
      await abortable(
        Promise.resolve(this.options.resolvePrincipal(id)),
        this.controller.signal,
      ),
    );
    if (
      !parsed.success ||
      !parsed.data.jobs.includes(operation) ||
      (expectedSubject && parsed.data.subject !== expectedSubject)
    )
      throw new DriverError(
        "FORBIDDEN",
        "Current host credentials do not grant this job operation.",
      );
    return parsed.data;
  }
  private scope(
    request: RunRequest,
    principal: z.infer<typeof principalSchema>,
  ) {
    if (
      !principal.providers.includes(request.provider) ||
      request.tools?.some((name) => !principal.tools.includes(name)) ||
      (request.retrieval &&
        !principal.retrieval.includes(request.retrieval.corpus))
    )
      throw new DriverError(
        "FORBIDDEN",
        "Current job credentials do not grant the requested provider, tools or corpus.",
      );
  }
  private validate(request: RunRequest) {
    // These tickets and opaque sessions belong to a foreground host process. Persisting a
    // dispatch event would invite an application to repeat side effects after reconnect.
    if (
      request.session ||
      request.applicationTools ||
      request.approvals ||
      request.idempotencyKey
    )
      throw new DriverError(
        "JOB_REQUEST_UNSUPPORTED",
        "Detached jobs use their own deduplication key, stateless history and registered host tools. Process-local sessions, application executors and interactive approvals require foreground runs.",
      );
    return this.driver.validate(request);
  }
  private account(request: RunRequest, subject: string) {
    const identity = this.driver.usageIdentity(request.provider, subject);
    if (!identity.accountId)
      throw new DriverError(
        "JOB_ACCOUNT_REQUIRED",
        "Bind an explicit host and account identity before accepting durable jobs.",
      );
    return { hostId: identity.hostId, accountId: identity.accountId };
  }
  async submit(input: JobSubmit, principalId: string): Promise<JobInfo> {
    this.assertOpen();
    const parsed = JobSubmitSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_JOB",
        "The job submission does not match the schema.",
      );
    const principal = await this.principal(principalId, "submit");
    const request = this.validate(parsed.data.request);
    this.scope(request, principal);
    const account = this.account(request, principal.subject);
    const record = await this.options.store.submit({
      request,
      subject: principal.subject,
      principal: principalId,
      account,
      keyHash: operationKey(principal.subject, parsed.data.key),
      fingerprint: newOperation(request, "fingerprint").fingerprint,
    });
    this.kick();
    return structuredClone(record.info);
  }
  private async lookup(
    input: JobIdentity,
    principalId: string,
    operation: "read" | "cancel",
  ) {
    this.assertOpen();
    const parsed = JobIdentitySchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError("INVALID_JOB", "Supply a valid job identity.");
    const principal = await this.principal(principalId, operation);
    const record = await this.options.store.read(
      principal.subject,
      parsed.data.id,
    );
    this.scope(record.request, principal);
    return record;
  }
  async read(input: JobIdentity, principalId: string): Promise<JobInfo> {
    return structuredClone(
      (await this.lookup(input, principalId, "read")).info,
    );
  }
  async cancel(input: JobIdentity, principalId: string): Promise<JobInfo> {
    const record = await this.lookup(input, principalId, "cancel");
    const cancelled = await this.options.store.cancel(
      record.subject,
      record.info.id,
    );
    this.active
      .get(record.info.id)
      ?.controller.abort(
        new DriverError(
          "CANCELLED",
          "The application cancelled this detached job.",
        ),
      );
    return structuredClone(cancelled.info);
  }
  async events(
    input: JobEventsRequest,
    principalId: string,
    signal?: AbortSignal,
  ): Promise<JobEventPage> {
    const parsed = JobEventsRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_JOB_CURSOR",
        "Supply a nonnegative cursor and a page size from 1 to 100.",
      );
    const record = await this.lookup(
      { id: parsed.data.id },
      principalId,
      "read",
    );
    if (parsed.data.after > record.info.cursor)
      throw new DriverError(
        "INVALID_JOB_CURSOR",
        "The cursor is ahead of this job's committed event log.",
      );
    const references = record.request.attachments?.some(
      (input) => input.type === "reference",
    );
    if (
      (references || record.request.retrieval) &&
      record.info.state !== "completed"
    )
      throw new DriverError(
        "CONTEXT_REPLAY_UNAVAILABLE",
        "Evidence-backed job events require a complete snapshot to reauthorize. Inspect job status and reconcile interrupted evidence in the application.",
        false,
        "uncertain",
      );
    await this.driver.authorizeReplay(
      record.request,
      record.info.runId,
      record.events,
      { subject: record.subject, signal },
    );
    const events = [] as JobRecord["events"];
    let bytes = 0;
    for (const event of record.events.slice(
      parsed.data.after,
      parsed.data.after + (parsed.data.limit ?? 100),
    )) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 1_500_000) break;
      events.push(event);
      bytes += size;
    }
    const nextCursor = events.at(-1)?.sequence ?? parsed.data.after;
    return {
      job: structuredClone(record.info),
      events: structuredClone(events),
      nextCursor,
      hasMore: nextCursor < record.info.cursor,
    };
  }
  private kick() {
    if (this.pumping || this.controller.signal.aborted) return;
    this.pumping = this.pump()
      .catch((error) => this.fatal(error))
      .finally(() => {
        this.pumping = undefined;
      });
  }
  private renew() {
    if (this.renewing || this.controller.signal.aborted) return;
    this.renewing = this.options.store
      .renew(this.owner, this.worker.leaseMs)
      .catch((error) => this.fatal(error))
      .finally(() => {
        this.renewing = undefined;
      });
  }
  private fatal(error: unknown) {
    try {
      this.options.onError?.(error);
    } catch {
      /* Diagnostics never affect fencing. */
    }
    this.controller.abort(
      new DriverError(
        "JOB_LEASE_LOST",
        "The job worker lost storage ownership.",
        false,
        "uncertain",
      ),
    );
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    for (const entry of this.active.values())
      entry.controller.abort(this.controller.signal.reason);
  }
  private async pump() {
    const records = await this.options.store.queued(this.owner);
    for (const entry of this.active.values()) {
      const current = await this.options.store
        .read(entry.record.subject, entry.record.info.id)
        .catch((error: unknown) => {
          if (error instanceof DriverError && error.code === "JOB_EXPIRED")
            return undefined;
          throw error;
        });
      if (current?.info.cancelRequested)
        entry.controller.abort(
          new DriverError(
            "CANCELLED",
            "The application cancelled this detached job.",
          ),
        );
    }
    // One candidate per subject per round. The shared scheduler still enforces host/account caps.
    const groups = new Map<string, JobRecord[]>();
    for (const record of records)
      if (!this.active.has(record.info.id)) {
        const group = groups.get(record.subject) ?? [];
        group.push(record);
        groups.set(record.subject, group);
      }
    const candidates: JobRecord[] = [];
    while (groups.size) {
      for (const [subject, group] of groups) {
        candidates.push(group.shift()!);
        if (!group.length) groups.delete(subject);
      }
    }
    // Rotate even when admission rejects a candidate. A blocked account must not
    // monopolize the dispatch window when maxWorkers is smaller than the backlog.
    const offset =
      candidates.findIndex((record) => record.info.id === this.lastCandidate) +
      1;
    for (const record of [
      ...candidates.slice(offset),
      ...candidates.slice(0, offset),
    ]) {
      if (
        this.active.size >= this.worker.maxWorkers ||
        this.controller.signal.aborted
      )
        break;
      this.lastCandidate = record.info.id;
      const controller = new AbortController();
      const pending = this.execute(record, controller)
        .catch((error) => this.fatal(error))
        .finally(() => this.active.delete(record.info.id));
      this.active.set(record.info.id, { record, controller, pending });
    }
  }
  private async execute(record: JobRecord, controller: AbortController) {
    let ticket: AdmissionTicket | undefined;
    try {
      const principal = await this.principal(
        record.principal,
        "submit",
        record.subject,
      );
      this.scope(record.request, principal);
      const request = this.validate(record.request);
      const account = this.account(request, record.subject);
      if (
        account.hostId !== record.account.hostId ||
        account.accountId !== record.account.accountId
      )
        throw new DriverError(
          "JOB_ACCOUNT_CHANGED",
          "The accepted job's account binding has changed.",
        );
      ticket = this.scheduler.trySubmit(
        this.driver.usageIdentity(request.provider, record.subject),
        controller.signal,
      );
      if (!ticket) return;
      await ticket.wait();
      // A queued ticket can outlive a permission change. Recheck immediately before claiming execution.
      this.scope(
        request,
        await this.principal(record.principal, "submit", record.subject),
      );
      controller.signal.throwIfAborted();
      if (!(await this.options.store.start(this.owner, record.info.id))) return;
      for await (const event of this.driver.stream(request, {
        runId: record.info.runId,
        subject: record.subject,
        signal: controller.signal,
        admission: async () => {},
      })) {
        // The generator is suspended here. Commit a tool.called event before requesting
        // the next item, which is what permits the underlying tool implementation to run.
        await this.options.store.append(this.owner, record.info.id, event);
      }
    } catch (error) {
      if (this.controller.signal.aborted) return;
      if (
        error instanceof DriverError &&
        ["BUSY", "QUEUE_FULL"].includes(error.code)
      )
        return;
      await this.options.store.fail(
        this.owner,
        record.info.id,
        publicError(error, controller.signal).toJSON(),
      );
    } finally {
      controller.abort();
      ticket?.release();
    }
  }
  /** Queued jobs remain queued; started jobs receive a durable interruption barrier. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      clearInterval(this.timer);
      clearInterval(this.heartbeat);
      this.controller.abort();
      await Promise.allSettled([this.pumping, this.renewing]);
      // Fence before waiting for arbitrary provider/tool teardown. No job is re-queued.
      await this.options.store.release(this.owner).catch((error: unknown) => {
        if (!(error instanceof DriverError && error.code === "JOB_LEASE_LOST"))
          throw error;
      });
      for (const entry of this.active.values()) entry.controller.abort();
      await Promise.allSettled(
        [...this.active.values()].map((entry) => entry.pending),
      );
    })());
  }
}
