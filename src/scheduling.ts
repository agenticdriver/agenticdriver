import { z } from "zod";
import { DriverError, publicError } from "./errors.js";
import { UsageIdSchema } from "./usage.js";

const capacity = z.number().int().min(1).max(100_000);
const subject = z.string().min(1).max(128);
export const SchedulingOptionsSchema = z
  .object({
    total: capacity.optional(),
    perSubject: capacity.optional(),
    perAccount: capacity.optional(),
    subjects: z.record(subject, capacity).optional(),
    accounts: z.record(UsageIdSchema, capacity).optional(),
    /** Omitted means reject immediately when capacity is unavailable. */
    queue: z
      .object({ total: capacity, perSubject: capacity })
      .strict()
      .optional(),
  })
  .strict();
export type SchedulingOptions = z.infer<typeof SchedulingOptionsSchema>;
/** Zod discards this object key; rejecting it avoids silently losing a policy. */
export function assertPolicyMaps(input: unknown, code: string) {
  if (!input || typeof input !== "object") return;
  for (const name of ["subjects", "accounts"]) {
    const value = (input as Record<string, unknown>)[name];
    if (value && typeof value === "object" && Object.hasOwn(value, "__proto__"))
      throw new DriverError(
        code,
        "Policy maps cannot use the reserved __proto__ key; choose a different subject or account identifier.",
      );
  }
}
export interface SchedulingIdentity {
  subject: string;
  hostId?: string;
  accountId?: string;
  /** Present for generation; retrieval admission uses only its subject. */
  provider?: string;
}
export interface AdmissionTicket {
  /** Pending tickets have no timer. Cancellation and release are idempotent. */
  wait(): Promise<void>;
  release(): void;
}
interface Entry {
  subject: string;
  account?: string;
  subjectLimit: number;
  accountLimit: number;
  state: "queued" | "active" | "released";
  settle(value?: DriverError): void;
  cleanup(): void;
}

/** Process-local, non-preemptive round robin among eligible authenticated subjects. */
export class FairScheduler {
  private readonly options: SchedulingOptions;
  private readonly subjects = new Map<string, number>();
  private readonly accounts = new Map<string, number>();
  private readonly pending = new Map<string, Entry[]>();
  private readonly order: string[] = [];
  private active = 0;
  private queued = 0;
  constructor(input: SchedulingOptions = {}) {
    assertPolicyMaps(input, "INVALID_SCHEDULING");
    const parsed = SchedulingOptionsSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_SCHEDULING",
        "Configure positive concurrency and bounded queue capacities.",
      );
    this.options = parsed.data;
  }
  get stats(): Readonly<{ active: number; queued: number }> {
    return { active: this.active, queued: this.queued };
  }
  submit(identity: SchedulingIdentity, signal: AbortSignal): AdmissionTicket {
    if (signal.aborted) throw publicError(signal.reason, signal);
    if (!subject.safeParse(identity.subject).success)
      throw new DriverError(
        "INVALID_SCHEDULING_IDENTITY",
        "Admission requires an authenticated subject of at most 128 characters.",
      );
    const bound =
      identity.hostId !== undefined && identity.accountId !== undefined;
    if (
      (bound &&
        (!UsageIdSchema.safeParse(identity.hostId).success ||
          !UsageIdSchema.safeParse(identity.accountId).success)) ||
      (identity.provider &&
        !bound &&
        (this.options.perAccount !== undefined ||
          Object.keys(this.options.accounts ?? {}).length))
    )
      throw new DriverError(
        "ADMISSION_IDENTITY_REQUIRED",
        "Account admission requires a trusted host and account binding for this provider.",
      );
    let settle!: (value?: DriverError) => void;
    // Resolve with an error value, rather than an unobserved rejection when a
    // request replays a recorded outcome without awaiting its ticket.
    const admission = new Promise<DriverError | undefined>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = {
      subject: identity.subject,
      account: bound
        ? JSON.stringify([identity.hostId, identity.accountId])
        : undefined,
      subjectLimit:
        this.options.subjects &&
        Object.hasOwn(this.options.subjects, identity.subject)
          ? this.options.subjects[identity.subject]!
          : (this.options.perSubject ?? 4),
      accountLimit:
        identity.accountId &&
        this.options.accounts &&
        Object.hasOwn(this.options.accounts, identity.accountId)
          ? this.options.accounts[identity.accountId]!
          : (this.options.perAccount ?? this.options.total ?? 32),
      state: "queued",
      settle,
      cleanup: () => {},
    };
    this.pump();
    if (this.eligible(entry)) this.start(entry);
    else {
      const queue = this.options.queue;
      if (!queue)
        throw new DriverError(
          "BUSY",
          "Execution capacity is full for this host, subject or account. Retry after active work finishes, or configure a bounded queue.",
          true,
        );
      if (
        this.queued >= queue.total ||
        (this.pending.get(entry.subject)?.length ?? 0) >= queue.perSubject
      )
        throw new DriverError(
          "QUEUE_FULL",
          "The host or subject waiting queue is full. Retry after queued work advances; do not switch providers automatically.",
          true,
        );
      const items = this.pending.get(entry.subject);
      if (items) items.push(entry);
      else {
        this.pending.set(entry.subject, [entry]);
        this.order.push(entry.subject);
      }
      this.queued++;
    }
    const release = () => {
      if (entry.state === "released") return;
      if (entry.state === "active") {
        this.active--;
        this.decrement(this.subjects, entry.subject);
        if (entry.account) this.decrement(this.accounts, entry.account);
      } else {
        const items = this.pending.get(entry.subject)!;
        items.splice(items.indexOf(entry), 1);
        this.queued--;
        this.prune(entry.subject);
        entry.settle(
          signal.aborted
            ? publicError(signal.reason, signal)
            : new DriverError("CANCELLED", "The queued request was withdrawn."),
        );
      }
      entry.state = "released";
      entry.cleanup();
      this.pump();
    };
    const abort = () => release();
    entry.cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    return {
      async wait() {
        const failure = await admission;
        if (signal.aborted) throw publicError(signal.reason, signal);
        if (failure) throw failure;
        if (entry.state === "released")
          throw new DriverError(
            "CANCELLED",
            "Admission was released before execution.",
          );
      },
      release,
    };
  }
  private decrement(map: Map<string, number>, key: string) {
    const count = map.get(key)! - 1;
    if (count) map.set(key, count);
    else map.delete(key);
  }
  private eligible(entry: Entry) {
    return (
      this.active < (this.options.total ?? 32) &&
      (this.subjects.get(entry.subject) ?? 0) < entry.subjectLimit &&
      (!entry.account ||
        (this.accounts.get(entry.account) ?? 0) < entry.accountLimit)
    );
  }
  private start(entry: Entry) {
    entry.state = "active";
    this.active++;
    this.subjects.set(
      entry.subject,
      (this.subjects.get(entry.subject) ?? 0) + 1,
    );
    if (entry.account)
      this.accounts.set(
        entry.account,
        (this.accounts.get(entry.account) ?? 0) + 1,
      );
    entry.settle();
  }
  private prune(key: string) {
    if (this.pending.get(key)?.length) return;
    this.pending.delete(key);
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
  }
  private pump() {
    // One eligible request per subject per rotation. A blocked account does not
    // prevent another account belonging to that subject from using a free slot.
    let skipped = 0;
    while (
      this.active < (this.options.total ?? 32) &&
      this.order.length &&
      skipped < this.order.length
    ) {
      const key = this.order.shift()!;
      const items = this.pending.get(key)!;
      const index = items.findIndex((entry) => this.eligible(entry));
      if (index < 0) {
        this.order.push(key);
        skipped++;
        continue;
      }
      const [entry] = items.splice(index, 1);
      this.queued--;
      if (items.length) this.order.push(key);
      else this.pending.delete(key);
      this.start(entry!);
      skipped = 0;
    }
  }
}
