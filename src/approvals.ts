import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DriverError } from "./errors.js";
import {
  ApprovalCallSchema,
  ApprovalDecisionSchema,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalResolution,
} from "./approval-types.js";
import type { ExecutionContext, ToolCall } from "./types.js";

export type ApprovalAuditRecord =
  | {
      type: "approval.requested";
      subject: string;
      provider: string;
      approval: ApprovalRequest;
    }
  | {
      type: "approval.resolved";
      subject: string;
      provider: string;
      approval: ApprovalRequest;
      resolution: ApprovalResolution;
    }
  | {
      type: "approval.rejected";
      subject: string;
      approvalId?: string;
      runId?: string;
      code: string;
    };

export interface ApprovalOptions {
  /** The host must explicitly enable application decisions. */
  interactive: true;
  /** Set false to require the configured inactivity timer to keep running during human review. */
  allowIdlePause?: boolean;
  /** Capacity bound, not a timeout. Pending requests are never silently evicted. */
  maxPending?: number;
  /** Synchronous private audit sink. Throwing fails closed before tool execution. */
  onAudit?: (record: ApprovalAuditRecord) => void;
}

export interface ApprovalPrincipal {
  subject?: string;
  /** Remote grants are supplied by the host, never by the decision body. */
  providers?: readonly string[];
  approveTools?: readonly string[];
}
interface Pending {
  subject: string;
  provider: string;
  approval: ApprovalRequest;
  signal: AbortSignal;
  finish(outcome: ApprovalResolution["outcome"]): ApprovalResolution;
}

/** Process-local waits. Restart/disconnect never restores permission to execute. */
export class ApprovalManager {
  private readonly pending = new Map<string, Pending>();
  private readonly maxPending: number;
  constructor(private readonly options?: ApprovalOptions) {
    this.maxPending = options?.maxPending ?? 1000;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new Error("Approval maxPending must be a positive integer.");
  }
  get enabled(): boolean {
    return this.options?.interactive === true;
  }
  validate(policy?: ApprovalPolicy) {
    if (!policy) return;
    if (!this.enabled)
      throw new DriverError(
        "APPROVAL_UNAVAILABLE",
        "This host has not enabled interactive approvals.",
      );
    if (policy.idlePolicy === "pause" && this.options?.allowIdlePause === false)
      throw new DriverError(
        "APPROVAL_POLICY",
        "This host requires inactivity accounting to continue while awaiting approval.",
      );
  }
  private audit(record: ApprovalAuditRecord) {
    try {
      const value: unknown = this.options?.onAudit?.(structuredClone(record));
      // Reject accidental async sinks: they cannot enforce a synchronous commit barrier.
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(value).catch(() => {});
        throw new Error("async audit sink");
      }
    } catch {
      throw new DriverError(
        "APPROVAL_AUDIT_FAILED",
        "The host could not record the approval lifecycle. No tool was authorized by this decision.",
      );
    }
  }
  request(
    call: ToolCall,
    provider: string,
    policy: ApprovalPolicy,
    context: ExecutionContext,
  ) {
    this.validate(policy);
    context.signal.throwIfAborted();
    if (this.pending.size >= this.maxPending)
      throw new DriverError(
        "APPROVAL_CAPACITY",
        "The host has reached its pending approval capacity.",
        true,
      );
    const parsed = ApprovalCallSchema.safeParse(call);
    if (
      !parsed.success ||
      !isDeepStrictEqual(parsed.data.arguments, call.arguments) ||
      // Leave room for clients that escape every non-ASCII or HTML character
      // within the host's 1 MB JSON request bound when echoing the reviewed call.
      Buffer.byteLength(JSON.stringify(parsed.data)) > 128_000
    )
      throw new DriverError(
        "INVALID_TOOL_CALL",
        "The proposed tool call cannot be represented in a bounded approval request.",
      );
    const approval: ApprovalRequest = {
      approvalId: randomUUID(),
      runId: context.runId,
      call: parsed.data,
      requestedAt: new Date().toISOString(),
      idlePolicy: policy.idlePolicy,
      ...(policy.expiresAfterMs === undefined
        ? {}
        : {
            expiresAt: new Date(
              Date.now() + policy.expiresAfterMs,
            ).toISOString(),
          }),
    };
    let settle!: (value: ApprovalResolution | DriverError) => void;
    // Always resolve, including cancellation before the generator resumes after yielding.
    const result = new Promise<ApprovalResolution | DriverError>((resolve) => {
      settle = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished: ApprovalResolution | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
      this.pending.delete(approval.approvalId);
    };
    const finish = (
      outcome: ApprovalResolution["outcome"],
    ): ApprovalResolution => {
      if (finished) return structuredClone(finished);
      finished = {
        approvalId: approval.approvalId,
        runId: approval.runId,
        callId: approval.call.id,
        outcome,
        decidedAt: new Date().toISOString(),
      };
      cleanup();
      try {
        this.audit({
          type: "approval.resolved",
          subject: context.subject,
          provider,
          approval,
          resolution: finished,
        });
      } catch (error) {
        settle(error as DriverError);
        throw error;
      }
      settle(structuredClone(finished));
      return structuredClone(finished);
    };
    const cancel = () => {
      try {
        finish("cancelled");
      } catch {
        /* The waiter receives the audit failure. */
      }
    };
    this.pending.set(approval.approvalId, {
      approval,
      subject: context.subject,
      provider,
      signal: context.signal,
      finish,
    });
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      this.audit({
        type: "approval.requested",
        subject: context.subject,
        provider,
        approval,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    if (!finished && policy.expiresAfterMs !== undefined)
      timer = setTimeout(() => {
        try {
          finish("expired");
        } catch {
          /* Delivered to the waiter. */
        }
      }, policy.expiresAfterMs);
    if (context.signal.aborted) cancel();
    return { approval: structuredClone(approval), result, cancel };
  }
  decide(
    input: ApprovalDecision,
    principal: ApprovalPrincipal = {},
  ): ApprovalResolution {
    const parsed = ApprovalDecisionSchema.safeParse(input);
    if (
      !parsed.success ||
      !isDeepStrictEqual(parsed.data.call.arguments, input.call.arguments)
    ) {
      this.audit({
        type: "approval.rejected",
        subject: principal.subject ?? "local",
        code: "INVALID_APPROVAL",
        ...(typeof input?.approvalId === "string" &&
        input.approvalId.length <= 256
          ? { approvalId: input.approvalId }
          : {}),
        ...(typeof input?.runId === "string" && input.runId.length <= 256
          ? { runId: input.runId }
          : {}),
      });
      throw new DriverError(
        "INVALID_APPROVAL",
        "The approval decision does not match the schema.",
      );
    }
    const decision = parsed.data,
      subject = principal.subject ?? "local";
    const reject = (code: string, message: string): never => {
      this.audit({
        type: "approval.rejected",
        subject,
        approvalId: decision.approvalId,
        runId: decision.runId,
        code,
      });
      throw new DriverError(code, message);
    };
    const pending = this.pending.get(decision.approvalId);
    if (!pending || pending.subject !== subject)
      return reject(
        "APPROVAL_NOT_FOUND",
        "No pending approval is available to this subject.",
      );
    if (pending.signal.aborted) {
      pending.finish("cancelled");
      return reject(
        "APPROVAL_NOT_FOUND",
        "No pending approval is available to this subject.",
      );
    }
    if (
      pending.approval.expiresAt &&
      Date.now() >= Date.parse(pending.approval.expiresAt)
    ) {
      pending.finish("expired");
      return reject(
        "APPROVAL_NOT_FOUND",
        "No pending approval is available to this subject.",
      );
    }
    if (
      (principal.providers &&
        !principal.providers.includes(pending.provider)) ||
      (principal.approveTools &&
        !principal.approveTools.includes(pending.approval.call.name))
    )
      return reject(
        "FORBIDDEN",
        "This token cannot decide this provider's tool approval.",
      );
    if (
      decision.runId !== pending.approval.runId ||
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify(decision.call)),
        JSON.parse(JSON.stringify(pending.approval.call)),
      )
    )
      return reject(
        "APPROVAL_MISMATCH",
        "The decision does not identify the exact run, tool call and arguments awaiting review.",
      );
    return pending.finish(
      { approve: "approved", deny: "denied", cancel: "cancelled" }[
        decision.decision
      ] as ApprovalResolution["outcome"],
    );
  }
}
