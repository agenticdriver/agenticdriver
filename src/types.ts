import { z } from "zod";
import {
  PortableMessageSchema,
  SessionHandleSchema,
  type SessionInfo,
  type SessionOperation,
} from "./session-types.js";
export type * from "./session-types.js";
import {
  ApplicationToolDefinitionSchema,
  type ToolExecutionRequest,
} from "./tool-types.js";
export type * from "./tool-types.js";
import {
  ApprovalPolicySchema,
  type ApprovalRequest,
  type ApprovalResolution,
} from "./approval-types.js";
export type * from "./approval-types.js";
import {
  RetrievalRequestSchema,
  type RetrievalResult,
} from "./retrieval-types.js";
import {
  ArtifactRequestSchema,
  ContextInputSchema,
  type ContextAttachment,
  type ContextManifest,
  type DraftArtifact,
  type ContextMediaType,
} from "./context-types.js";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type AuthMode = "api-key" | "cli-session" | "none";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(5),
    baseDelayMs: z.number().int().min(0).max(60_000).optional(),
    maxDelayMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export const RunRequestSchema = z
  .object({
    provider: id,
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/),
    input: z.string().min(1).max(100_000),
    attachments: z.array(ContextInputSchema).max(16).optional(),
    retrieval: RetrievalRequestSchema.optional(),
    outputArtifact: ArtifactRequestSchema.optional(),
    idempotencyKey: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
      .optional(),
    retry: RetryPolicySchema.optional(),
    instructions: z.string().max(100_000).optional(),
    history: z.array(PortableMessageSchema).max(100).optional(),
    session: SessionHandleSchema.optional(),
    approvals: ApprovalPolicySchema.optional(),
    applicationTools: z
      .array(ApplicationToolDefinitionSchema)
      .min(1)
      .max(32)
      .optional(),
    tools: z
      .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/))
      .max(32)
      .optional(),
    /** Required provider capabilities must be advertised as true before execution. */
    requiredCapabilities: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/))
      .max(32)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    maxSteps: z.number().int().min(1).max(64).optional(),
    maxOutputTokens: z.number().int().min(1).max(65_536).optional(),
    /** No timer by default. Zero also disables it unless the host requires one. */
    idleTimeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    metadata: z
      .record(z.string().max(80), z.string().max(500))
      .refine((v) => Object.keys(v).length <= 32)
      .optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

/** Unknown measurements are omitted, never invented or treated as free usage. */
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const UsageSchema = z.object({
  inputTokens: tokenCount.optional(),
  outputTokens: tokenCount.optional(),
  cachedInputTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
  /** Explicit provider-reported cost; never inferred from a subscription plan. */
  costUsd: z.number().nonnegative().optional(),
  /** Reported API-equivalent estimate, not an invoice or subscription charge. */
  apiEquivalentCostUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;
export type UsageSource =
  "provider-response" | "cli-report" | "adapter-report" | "synthetic";
export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ExecutionContext {
  runId: string;
  subject: string;
  signal: AbortSignal;
  /** Report actual work completed, such as a page fetched or batch processed. */
  reportProgress(): void;
}
export interface ProviderContext extends ExecutionContext {
  /** Emit new visible text only; the final turn must still contain the full text. */
  emitText(text: string): void;
}
export interface Tool extends ToolDefinition {
  /** Required approval fails closed without a host callback or an explicitly enabled interactive decision. */
  requiresApproval?: boolean;
  execute(input: JsonObject, context: ExecutionContext): Promise<Json> | Json;
}
export type ProviderMessage =
  | {
      role: "user";
      content: string;
      attachments?: Exclude<ContextAttachment, { type: "text" }>[];
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      native?: unknown;
    }
  | { role: "tool"; content: string; callId: string; name: string };
export interface ProviderRequest {
  model: string;
  instructions?: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  retry?: RetryPolicy;
}
export interface ProviderTurn {
  text: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  /** Private provider state; retained across runs only in explicitly selected native sessions. */
  native?: unknown;
  finishReason?: "stop" | "length";
}
export const ProviderHealthSchema = z.object({
  status: z.enum([
    "ready",
    "unauthenticated",
    "unavailable",
    "unsupported",
    "unknown",
  ]),
  code: z.string().min(1),
  message: z.string(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export const ModelCatalogSchema = z.object({
  source: z.enum(["provider", "configured", "unavailable"]),
  models: z.array(z.string()).max(1000),
  complete: z.boolean(),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
/** Inspection codes are converted to fixed public messages; raw diagnostics are never returned. */
export type ProviderInspectionCode =
  | "CATALOG_AVAILABLE"
  | "AUTH_REQUIRED"
  | "AUTH_REJECTED"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "PROVIDER_UNREACHABLE"
  | "DISCOVERY_UNSUPPORTED"
  | "INVALID_DISCOVERY_RESPONSE"
  | "CLI_UNAVAILABLE"
  | "CLI_UPGRADE_REQUIRED"
  | "CLI_SESSION_PRESENT"
  | "CLI_AUTH_REQUIRED"
  | "CLI_STATUS_UNKNOWN"
  | "DISCOVERY_TIMEOUT"
  | "DISCOVERY_FAILED";
export interface ProviderInspection {
  code: ProviderInspectionCode;
  models?: string[];
  complete?: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  vendor: string;
  authMode: AuthMode;
  capabilities: {
    tools: boolean;
    textStreaming: boolean;
    [capability: string]: boolean;
  };
  /** A server-owned allowlist. Omit to accept any explicit model ID. */
  models?: string[];
  /** Explicit model-specific media allowlists. Text context works with every text adapter. */
  inputMediaTypes?: Record<string, ContextMediaType[]>;
  usageStatId?: string;
  /** Advisory discovery metadata. It never changes the allowlist or run selection. */
  health?: ProviderHealth;
  modelCatalog?: ModelCatalog;
}
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  /** Provenance of this adapter's measurements, not a claim that they are invoice totals. */
  readonly usageSource?: UsageSource;
  /** Read-only, non-generation probe. Must honor cancellation and keep credentials private. */
  inspect?(context: { signal: AbortSignal }): Promise<ProviderInspection>;
  complete(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderTurn>;
}
export interface RunResult {
  session?: SessionInfo;
  runId: string;
  provider: string;
  model: string;
  text: string;
  output?: Json;
  usage: Usage;
  steps: number;
  finishReason: "stop" | "length";
  sources?: ContextManifest[];
  artifacts?: DraftArtifact[];
  retrieval?: RetrievalResult;
}
export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  /** An accepted operation or invoked tool may have produced effects that need reconciliation. */
  outcome?: "uncertain";
}
type EventPayload =
  | { type: "run.started"; provider: string; model: string }
  | { type: "step.started"; step: number }
  | { type: "text.delta"; text: string }
  | { type: "run.progress"; phase: "model" | "tool" | "context" }
  | { type: "tool.execution.requested"; execution: ToolExecutionRequest }
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "approval.resolved"; resolution: ApprovalResolution }
  | { type: "tool.called"; call: ToolCall }
  | { type: "tool.completed"; callId: string; output: Json }
  | { type: "usage.reported"; step: number; usage: Usage }
  | { type: "run.completed"; result: RunResult }
  | { type: "run.failed" | "run.cancelled"; error: ErrorInfo };
export type RunEvent = EventPayload & {
  runId: string;
  sequence: number;
  timestamp: string;
};
export type { EventPayload };
export interface RunOptions {
  /** Trusted host admission ticket; never accepted in request JSON. */
  admission?: () => Promise<void>;
  /** Trusted permissions from host authentication, never accepted in request JSON. */
  sessionOperations?: readonly SessionOperation[];
  /** Trusted host/token additions to application tool approval policy; never accepted in request JSON. */
  applicationToolApprovals?: readonly string[];
  signal?: AbortSignal;
  subject?: string;
}
export interface UsageRecord {
  schema: "agenticdriver.usage.v2";
  /** Stable aggregate event identity; retries at a sink must retain it. */
  eventId: string;
  hostId: string;
  /** Explicit trusted host binding; absent means the billing account is unbound. */
  accountId?: string;
  runId: string;
  subject: string;
  provider: string;
  vendor: string;
  model: string;
  authMode: AuthMode;
  status: "completed" | "failed" | "cancelled";
  source: UsageSource;
  startedAt: string;
  finishedAt: string;
  /** Sink deletion policy; omitted means the sink must choose its own retention. */
  expiresAt?: string;
  /** Totals only for fields reported by every started model step. */
  usage: Usage;
  /** Known subtotals; never treat these as complete run cost or quota usage. */
  observedUsage: Usage;
  coverage: {
    startedSteps: number;
    completedSteps: number;
    reportedSteps: Partial<Record<keyof Usage, number>>;
  };
  durationMs: number;
  /** Trusted host labels only. Run-request metadata is never copied into metering. */
  metadata: Record<string, string>;
}
