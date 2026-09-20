import { z } from "zod";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type AuthMode = "api-key" | "cli-session" | "none";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const RunRequestSchema = z
  .object({
    provider: id,
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/),
    input: z.string().min(1).max(100_000),
    instructions: z.string().max(100_000).optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(100_000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    tools: z
      .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/))
      .max(32)
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
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}
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
  /** A required approval fails closed if the host has not supplied an approval handler. */
  requiresApproval?: boolean;
  execute(input: JsonObject, context: ExecutionContext): Promise<Json> | Json;
}
export type ProviderMessage =
  | { role: "user"; content: string }
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
}
export interface ProviderTurn {
  text: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  /** Preserved only inside this run for reasoning blocks and signed function calls. */
  native?: unknown;
  finishReason?: "stop" | "length";
}
export interface ProviderInfo {
  id: string;
  name: string;
  vendor: string;
  authMode: AuthMode;
  capabilities: { tools: boolean; textStreaming: boolean };
  /** A server-owned allowlist. Omit to accept any explicit model ID. */
  models?: string[];
  usageStatId?: string;
}
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  complete(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderTurn>;
}
export interface RunResult {
  runId: string;
  provider: string;
  model: string;
  text: string;
  output?: Json;
  usage: Usage;
  steps: number;
  finishReason: "stop" | "length";
}
export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}
type EventPayload =
  | { type: "run.started"; provider: string; model: string }
  | { type: "step.started"; step: number }
  | { type: "text.delta"; text: string }
  | { type: "run.progress"; phase: "model" | "tool" }
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
  signal?: AbortSignal;
  subject?: string;
}
export interface UsageRecord {
  schema: "agenticdriver.usage.v1";
  runId: string;
  subject: string;
  provider: string;
  vendor: string;
  model: string;
  authMode: AuthMode;
  status: "completed" | "failed" | "cancelled";
  usage: Usage;
  durationMs: number;
  metadata: Record<string, string>;
}
