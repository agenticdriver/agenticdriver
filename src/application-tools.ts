import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DriverError } from "./errors.js";
import { ApprovalCallSchema } from "./approval-types.js";
import {
  ToolExecutionIdentitySchema,
  ToolExecutionResultSchema,
  type ToolExecutionIdentity,
  type ToolExecutionResult,
  type ToolExecutionReceipt,
  type ToolExecutionRequest,
} from "./tool-types.js";
import type { ExecutionContext, Json, ToolCall } from "./types.js";

export interface ApplicationToolOptions {
  enabled: true;
  /** Defaults to true; a token or the application can impose additional review. */
  requireApproval?: boolean;
  maxPending?: number;
}
export interface ToolExecutorPrincipal {
  subject?: string;
  providers?: readonly string[];
  applicationTools?: readonly string[];
}
/** Only the transport constructs these fixed public errors, not application callbacks. */
export class ApplicationToolError extends DriverError {}
interface Pending {
  subject: string;
  provider: string;
  execution: ToolExecutionRequest;
  signal: AbortSignal;
  validateOutput?: (output: Json) => boolean;
  progress(): void;
  finish(value: Json | ApplicationToolError): void;
}

/** Scoped execution tickets for application-owned functions. No executable code is accepted. */
export class ApplicationToolManager {
  private readonly pending = new Map<string, Pending>();
  private readonly maxPending: number;
  constructor(private readonly options?: ApplicationToolOptions) {
    this.maxPending = options?.maxPending ?? 1000;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new Error(
        "Application tool maxPending must be a positive integer.",
      );
  }
  get enabled() {
    return this.options?.enabled === true;
  }
  get requireApproval() {
    return this.options?.requireApproval !== false;
  }
  request(
    call: ToolCall,
    provider: string,
    context: ExecutionContext,
    validateOutput?: (output: Json) => boolean,
  ) {
    context.signal.throwIfAborted();
    if (!this.enabled)
      throw new DriverError(
        "APPLICATION_TOOLS_UNAVAILABLE",
        "This host has not enabled application executors.",
      );
    if (this.pending.size >= this.maxPending)
      throw new DriverError(
        "TOOL_EXECUTOR_CAPACITY",
        "The host has reached its pending application tool capacity.",
        true,
      );
    const parsed = ApprovalCallSchema.safeParse(call);
    if (
      !parsed.success ||
      !isDeepStrictEqual(parsed.data.arguments, call.arguments) ||
      Buffer.byteLength(JSON.stringify(parsed.data)) > 128_000
    )
      throw new DriverError(
        "INVALID_TOOL_CALL",
        "The tool call cannot be represented losslessly in a bounded executor request.",
      );
    const execution: ToolExecutionRequest = {
      executionId: randomUUID(),
      runId: context.runId,
      call: parsed.data,
    };
    let settle!: (value: Json | ApplicationToolError) => void;
    const result = new Promise<Json | ApplicationToolError>((resolve) => {
      settle = resolve;
    });
    let active = true,
      progressPending = false;
    let reportProgress: (() => void) | undefined;
    const finish = (value: Json | ApplicationToolError) => {
      if (!active) return;
      active = false;
      this.pending.delete(execution.executionId);
      context.signal.removeEventListener("abort", cancel);
      reportProgress = undefined;
      settle(
        value instanceof ApplicationToolError ? value : structuredClone(value),
      );
    };
    const cancel = () =>
      finish(
        new ApplicationToolError(
          "TOOL_EXECUTOR_DISCONNECTED",
          "The application tool connection ended before its outcome was confirmed.",
          false,
          "uncertain",
        ),
      );
    this.pending.set(execution.executionId, {
      subject: context.subject,
      provider,
      execution,
      signal: context.signal,
      validateOutput,
      finish,
      progress() {
        if (reportProgress) reportProgress();
        else {
          context.reportProgress();
          progressPending = true;
        }
      },
    });
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    return {
      execution: structuredClone(execution),
      cancel,
      async wait(progress: () => void): Promise<Json> {
        if (active) {
          reportProgress = progress;
          if (progressPending) progress();
        }
        const value = await result;
        if (value instanceof ApplicationToolError) throw value;
        return value;
      },
    };
  }
  private lookup(
    identity: ToolExecutionIdentity,
    principal: ToolExecutorPrincipal,
  ): Pending {
    const pending = this.pending.get(identity.executionId);
    if (
      !pending ||
      pending.subject !== (principal.subject ?? "local") ||
      pending.signal.aborted
    )
      throw new DriverError(
        "TOOL_EXECUTION_NOT_FOUND",
        "No pending tool execution is available to this subject.",
      );
    if (
      (principal.providers &&
        !principal.providers.includes(pending.provider)) ||
      (principal.applicationTools &&
        !principal.applicationTools.includes(pending.execution.call.name))
    )
      throw new DriverError(
        "FORBIDDEN",
        "This token cannot act as this tool's executor.",
      );
    if (
      identity.runId !== pending.execution.runId ||
      identity.callId !== pending.execution.call.id
    )
      throw new DriverError(
        "TOOL_EXECUTION_MISMATCH",
        "The message does not identify the pending run and tool call.",
      );
    return pending;
  }
  progress(
    input: ToolExecutionIdentity,
    principal: ToolExecutorPrincipal = {},
  ): ToolExecutionReceipt {
    const identity = ToolExecutionIdentitySchema.safeParse(input);
    if (!identity.success)
      throw new DriverError(
        "INVALID_TOOL_EXECUTION",
        "The tool progress message does not match the schema.",
      );
    this.lookup(identity.data, principal).progress();
    return { ...identity.data, status: "progress" };
  }
  complete(
    input: ToolExecutionResult,
    principal: ToolExecutorPrincipal = {},
  ): ToolExecutionReceipt {
    const parsed = ToolExecutionResultSchema.safeParse(input);
    if (
      !parsed.success ||
      ("output" in parsed.data &&
        (!("output" in input) ||
          !isDeepStrictEqual(parsed.data.output, input.output)))
    )
      throw new DriverError(
        "INVALID_TOOL_EXECUTION",
        "The tool result must match the schema without changing its output.",
      );
    const result = parsed.data,
      pending = this.lookup(result, principal);
    if ("error" in result) {
      pending.finish(
        new ApplicationToolError(
          "APPLICATION_TOOL_FAILED",
          "The application's tool callback failed. Reconcile any effects before replacing this operation.",
          false,
          "uncertain",
        ),
      );
    } else {
      const failure =
        Buffer.byteLength(JSON.stringify(result.output)) > 128_000
          ? new ApplicationToolError(
              "TOOL_OUTPUT_LIMIT",
              "Application tool output must not exceed 128,000 UTF-8 JSON bytes.",
              false,
              "uncertain",
            )
          : pending.validateOutput && !pending.validateOutput(result.output)
            ? new ApplicationToolError(
                "INVALID_TOOL_OUTPUT",
                "The application tool output did not match its declared schema.",
                false,
                "uncertain",
              )
            : undefined;
      if (failure) {
        pending.finish(failure);
        throw failure;
      }
      pending.finish(result.output);
    }
    return {
      executionId: result.executionId,
      runId: result.runId,
      callId: result.callId,
      status: "accepted",
    };
  }
}
