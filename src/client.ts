import { z } from "zod";
import {
  SessionInfoSchema,
  SessionSnapshotSchema,
  SessionDeleteResultSchema,
  validSessionResult,
  type SessionCreate,
  type SessionIdentity,
  type SessionSnapshot,
  type SessionDeleteResult,
} from "./session-types.js";
export type * from "./session-types.js";
import {
  ToolExecutionRequestSchema,
  ToolExecutionReceiptSchema,
  matchesToolReceipt,
  type ToolExecutionIdentity,
  type ToolExecutionResult,
  type ToolExecutionReceipt,
} from "./tool-types.js";
export type * from "./tool-types.js";
import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  matchesApprovalDecision,
  type ApprovalDecision,
  type ApprovalResolution,
} from "./approval-types.js";
export type * from "./approval-types.js";
import {
  ContextManifestSchema,
  validContextResult,
  DraftArtifactSchema,
  ContextMediaTypeSchema,
} from "./context-types.js";
export type * from "./context-types.js";
export type * from "./retrieval-types.js";
export type * from "./ingestion-types.js";
import { IngestResultSchema, type IngestRequest } from "./ingestion-types.js";
import type { IngestResult } from "./ingestion-types.js";
import {
  RetrievalResultSchema,
  RetrievalIndexResultSchema,
  RetrievalDeleteResultSchema,
  validRetrievalLinks,
  validRetrievalSelection,
  type RetrievalSearch,
  type RetrievalIndexRequest,
  type RetrievalDelete,
  type RetrievalResult,
  type RetrievalIndexResult,
  type RetrievalDeleteResult,
} from "./retrieval-types.js";
import {
  ModelCatalogSchema,
  ProviderHealthSchema,
  UsageSchema,
} from "./types.js";
import { abortable, cancelOnClose, DriverError } from "./errors.js";
export { DriverError } from "./errors.js";
export { PROTOCOL_VERSION } from "./protocol.js";
export type { ProtocolInfo } from "./protocol.js";
export type {
  RunRequest,
  RunResult,
  RunEvent,
  ProviderInfo,
  ProviderHealth,
  ModelCatalog,
  Usage,
  ErrorInfo,
  ToolCall,
  RetryPolicy,
  Json,
  JsonObject,
  AuthMode,
} from "./types.js";
import { readLimited, secureBaseUrl } from "./security.js";
import {
  checkResponseVersion,
  OPTIONAL_EVENTS_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  RUN_EVENT_TYPES,
  type ProtocolInfo,
} from "./protocol.js";
import type { ProviderInfo, RunEvent, RunRequest, RunResult } from "./types.js";
import {
  JobInfoSchema,
  type JobSubmit,
  type JobIdentity,
  type JobEventsRequest,
  type JobInfo,
  type JobEventPage,
} from "./job-types.js";
export type * from "./job-types.js";

export interface ClientOptions {
  url: string;
  /** A resolver can read rotated credentials from the application's auth/secret store. */
  token: string | ((signal?: AbortSignal) => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
}
/** A client may cancel transport; subject and provider credentials belong to the host. */
export interface ClientRequestOptions {
  signal?: AbortSignal;
}
export interface ProviderListOptions extends ClientRequestOptions {
  refresh?: boolean;
}
const errorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    outcome: z.literal("uncertain").optional(),
  }),
});
const usageSchema = UsageSchema;
const resultSchema = z
  .object({
    runId: z.string(),
    session: SessionInfoSchema.optional(),
    provider: z.string(),
    model: z.string(),
    text: z.string(),
    output: z.json().optional(),
    usage: usageSchema,
    steps: z.number().int().positive(),
    finishReason: z.enum(["stop", "length"]),
    sources: z.array(ContextManifestSchema).max(16).optional(),
    artifacts: z.array(DraftArtifactSchema).max(1).optional(),
    retrieval: RetrievalResultSchema.optional(),
  })
  .refine(validContextResult)
  .refine(validRetrievalLinks);
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool.execution.requested"),
    execution: ToolExecutionRequestSchema,
  }),
  z.object({
    type: z.literal("approval.requested"),
    approval: ApprovalRequestSchema,
  }),
  z.object({
    type: z.literal("approval.resolved"),
    resolution: ApprovalResolutionSchema,
  }),
  z.object({
    type: z.literal("run.started"),
    provider: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal("step.started"),
    step: z.number().int().positive(),
  }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  z.object({
    type: z.literal("run.progress"),
    phase: z.enum(["model", "tool", "context"]),
  }),
  z.object({
    type: z.literal("tool.called"),
    call: z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.json()),
    }),
  }),
  z.object({
    type: z.literal("tool.completed"),
    callId: z.string(),
    output: z.json(),
  }),
  z.object({
    type: z.literal("usage.reported"),
    step: z.number().int().positive(),
    usage: usageSchema,
  }),
  z.object({ type: z.literal("run.completed"), result: resultSchema }),
  z.object({
    type: z.enum(["run.failed", "run.cancelled"]),
    error: errorSchema.shape.error,
  }),
]);
const envelopeSchema = z.object({
  type: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime({ offset: true }),
  optional: z.boolean().optional(),
});

/** Browser-compatible client. Credentials here authenticate to your driver, not a model vendor. */
export class AgenticClient {
  private readonly base: URL;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: ClientOptions) {
    this.base = secureBaseUrl(options.url);
    if (!options.token)
      throw new DriverError(
        "AUTH_REQUIRED",
        "A driver bearer token is required.",
      );
    if (typeof (options.fetch ?? globalThis.fetch) !== "function")
      throw new DriverError(
        "UNSUPPORTED_ENVIRONMENT",
        "A Fetch-compatible implementation is required.",
      );
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async request(
    path: string,
    body?:
      | RunRequest
      | RetrievalSearch
      | RetrievalIndexRequest
      | RetrievalDelete
      | IngestRequest
      | ApprovalDecision
      | SessionCreate
      | SessionIdentity
      | JobSubmit
      | JobIdentity
      | JobEventsRequest
      | ToolExecutionIdentity
      | ToolExecutionResult,
    signal?: AbortSignal,
    stream = false,
  ): Promise<Response> {
    signal?.throwIfAborted();
    let token: string;
    try {
      const pending = Promise.resolve(
        typeof this.options.token === "function"
          ? this.options.token(signal)
          : this.options.token,
      );
      token = await (signal ? abortable(pending, signal) : pending);
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new DriverError(
        "AUTH_UNAVAILABLE",
        "The application's driver credential could not be resolved.",
      );
    }
    if (!token || token.length > 4096 || /[\s\0]/.test(token))
      throw new DriverError(
        "AUTH_REQUIRED",
        "A valid driver bearer token is required.",
      );
    signal?.throwIfAborted();
    const response = await this.fetcher(new URL(path, this.base), {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
        [OPTIONAL_EVENTS_HEADER]: "true",
        Accept: stream ? "text/event-stream" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readLimited(response, 64_000));
      } catch {
        /* Generic HTTP error below. */
      }
      const error = errorSchema.safeParse(parsed);
      if (error.success)
        throw new DriverError(
          error.data.error.code,
          error.data.error.message,
          error.data.error.retryable,
          error.data.error.outcome,
        );
      throw new DriverError(
        "HTTP_ERROR",
        `Driver returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      checkResponseVersion(response.headers.get(PROTOCOL_VERSION_HEADER));
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return response;
  }
  private async retrievalRequest<T extends z.ZodType>(
    path: string,
    body:
      RetrievalSearch | RetrievalIndexRequest | RetrievalDelete | IngestRequest,
    schema: T,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const response = await this.request(path, body, signal);
    const parsed = schema.safeParse(await readResponseJson(response));
    if (!parsed.success)
      throw new DriverError(
        "INVALID_RESPONSE",
        "The driver returned invalid retrieval metadata.",
      );
    return parsed.data;
  }
  async ingestContext(
    request: IngestRequest,
    options: ClientRequestOptions = {},
  ): Promise<IngestResult> {
    const result = await this.retrievalRequest(
      "v1/retrieval/ingest",
      request,
      IngestResultSchema,
      options.signal,
    );
    const source =
      request.document.type === "reference"
        ? request.document
        : request.document.source;
    if (
      result.corpus !== request.corpus ||
      result.sourceId !== source.id ||
      result.revision !== source.revision
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The ingestion receipt does not match the requested source.",
      );
    return result;
  }
  async searchContext(
    request: RetrievalSearch,
    options: ClientRequestOptions = {},
  ): Promise<RetrievalResult> {
    const result = await this.retrievalRequest(
      "v1/retrieval/search",
      request,
      RetrievalResultSchema,
      options.signal,
    );
    if (!validRetrievalSelection(result, request))
      throw new DriverError(
        "INVALID_RESPONSE",
        "The returned evidence does not match the selected corpus or sources.",
      );
    return result;
  }
  async indexContext(
    request: RetrievalIndexRequest,
    options: ClientRequestOptions = {},
  ): Promise<RetrievalIndexResult> {
    const result = await this.retrievalRequest(
      "v1/retrieval/index",
      request,
      RetrievalIndexResultSchema,
      options.signal,
    );
    if (
      result.corpus !== request.corpus ||
      result.sourceId !== request.source.id ||
      result.revision !== request.source.revision
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The indexing receipt does not match the requested source.",
      );
    return result;
  }
  async deleteContext(
    request: RetrievalDelete,
    options: ClientRequestOptions = {},
  ): Promise<RetrievalDeleteResult> {
    const result = await this.retrievalRequest(
      "v1/retrieval/delete",
      request,
      RetrievalDeleteResultSchema,
      options.signal,
    );
    if (
      result.corpus !== request.corpus ||
      result.sourceId !== request.sourceId ||
      result.revision !== request.revision
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The deletion receipt does not match the requested source.",
      );
    return result;
  }
  async protocol(options: ClientRequestOptions = {}): Promise<ProtocolInfo> {
    const response = await this.request(
      "v1/protocol",
      undefined,
      combineTimeout(options.signal, 10_000),
    );
    const parsed = z
      .object({
        protocol: z.literal("agenticdriver"),
        version: z.literal(PROTOCOL_VERSION),
        supportedVersions: z.array(z.string()),
        features: z.array(z.string()),
      })
      .safeParse(await readResponseJson(response));
    if (
      !parsed.success ||
      !parsed.data.supportedVersions.includes(PROTOCOL_VERSION)
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The driver returned an invalid protocol descriptor.",
      );
    return parsed.data;
  }
  async providers(options: ProviderListOptions = {}): Promise<ProviderInfo[]> {
    const response = await this.request(
      options.refresh ? "v1/providers?refresh=true" : "v1/providers",
      undefined,
      combineTimeout(options.signal, 10_000),
    );
    const result = z
      .object({
        providers: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            vendor: z.string(),
            authMode: z.enum(["api-key", "cli-session", "none"]),
            models: z.array(z.string()).optional(),
            inputMediaTypes: z
              .record(z.string(), z.array(ContextMediaTypeSchema).max(6))
              .optional(),
            usageStatId: z.string().optional(),
            health: ProviderHealthSchema.optional(),
            modelCatalog: ModelCatalogSchema.optional(),
            capabilities: z
              .object({
                tools: z.boolean(),
                textStreaming: z.boolean(),
              })
              .catchall(z.boolean()),
          }),
        ),
      })
      .safeParse(await readResponseJson(response));
    if (!result.success)
      throw new DriverError(
        "INVALID_RESPONSE",
        "The driver returned an invalid provider catalog.",
      );
    return result.data.providers;
  }
  async reportToolProgress(
    identity: ToolExecutionIdentity,
    options: ClientRequestOptions = {},
  ): Promise<ToolExecutionReceipt> {
    return this.toolRequest("progress", identity, options);
  }
  async completeTool(
    result: ToolExecutionResult,
    options: ClientRequestOptions = {},
  ): Promise<ToolExecutionReceipt> {
    return this.toolRequest("results", result, options);
  }
  private async toolRequest(
    operation: "progress" | "results",
    input: ToolExecutionIdentity | ToolExecutionResult,
    options: ClientRequestOptions,
  ): Promise<ToolExecutionReceipt> {
    const response = await this.request(
      `v1/tool-executions/${operation}`,
      input,
      options.signal,
    );
    const parsed = ToolExecutionReceiptSchema.safeParse(
      await readResponseJson(response),
    );
    if (
      !parsed.success ||
      !matchesToolReceipt(
        parsed.data,
        input,
        operation === "progress" ? "progress" : "accepted",
      )
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The tool execution receipt does not match its submission; reconcile the originating run.",
      );
    return parsed.data;
  }
  async decideApproval(
    decision: ApprovalDecision,
    options: ClientRequestOptions = {},
  ): Promise<ApprovalResolution> {
    const response = await this.request(
      "v1/approvals/decisions",
      decision,
      options.signal,
    );
    const parsed = ApprovalResolutionSchema.safeParse(
      await readResponseJson(response),
    );
    if (!parsed.success || !matchesApprovalDecision(parsed.data, decision))
      throw new DriverError(
        "INVALID_RESPONSE",
        "The approval receipt does not match the submitted decision. Observe the run stream to reconcile its outcome.",
      );
    return parsed.data;
  }
  async run(
    request: RunRequest,
    options: ClientRequestOptions = {},
  ): Promise<RunResult> {
    if (request.applicationTools)
      throw new DriverError(
        "TOOL_STREAM_REQUIRED",
        "Use stream() to execute application-owned tools.",
      );
    if (request.approvals)
      throw new DriverError(
        "APPROVAL_STREAM_REQUIRED",
        "Use stream() to receive and decide interactive approvals.",
      );
    for await (const event of this.stream(request, options)) {
      if (event.type === "run.completed") return event.result;
      if (event.type === "run.failed" || event.type === "run.cancelled")
        throw new DriverError(
          event.error.code,
          event.error.message,
          event.error.retryable,
          event.error.outcome,
        );
    }
    throw new DriverError(
      "INCOMPLETE_STREAM",
      "The run ended without a result.",
    );
  }
  async submitJob(
    input: JobSubmit,
    options: ClientRequestOptions = {},
  ): Promise<JobInfo> {
    return this.jobRequest("submit", input, options);
  }
  async readJob(
    input: JobIdentity,
    options: ClientRequestOptions = {},
  ): Promise<JobInfo> {
    return this.jobRequest("read", input, options);
  }
  async cancelJob(
    input: JobIdentity,
    options: ClientRequestOptions = {},
  ): Promise<JobInfo> {
    return this.jobRequest("cancel", input, options);
  }
  private async jobRequest(
    operation: "submit" | "read" | "cancel",
    input: JobSubmit | JobIdentity,
    options: ClientRequestOptions,
  ): Promise<JobInfo> {
    const result = JobInfoSchema.safeParse(
      await readResponseJson(
        await this.request(`v1/jobs/${operation}`, input, options.signal),
      ),
    );
    if (
      !result.success ||
      ("id" in input
        ? result.data.id !== input.id
        : result.data.provider !== input.request.provider ||
          result.data.model !== input.request.model)
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The host returned invalid or mismatched job metadata.",
      );
    return result.data;
  }
  async jobEvents(
    input: JobEventsRequest,
    options: ClientRequestOptions = {},
  ): Promise<JobEventPage> {
    const raw = await readResponseJson(
      await this.request("v1/jobs/events", input, options.signal),
    );
    const page = z
      .object({
        job: JobInfoSchema,
        events: z.array(z.unknown()).max(100),
        nextCursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        hasMore: z.boolean(),
      })
      .safeParse(raw);
    const invalid = () =>
      new DriverError(
        "INVALID_RESPONSE",
        "The host returned an invalid or out-of-order job event page.",
      );
    if (
      !page.success ||
      page.data.job.id !== input.id ||
      page.data.events.length > (input.limit ?? 100)
    )
      throw invalid();
    const { job, nextCursor, hasMore } = page.data;
    let cursor = input.after;
    const events: RunEvent[] = [];
    for (const value of page.data.events) {
      const envelope = envelopeSchema.safeParse(value),
        payload = eventSchema.safeParse(value);
      if (
        !envelope.success ||
        !payload.success ||
        envelope.data.runId !== job.runId ||
        envelope.data.sequence !== ++cursor ||
        cursor > job.cursor
      )
        throw invalid();
      const event: RunEvent = { ...envelope.data, ...payload.data };
      const ended = ["run.completed", "run.failed", "run.cancelled"].includes(
        event.type,
      );
      const terminal = job.state !== "queued" && job.state !== "running";
      if (
        (event.type === "run.started") !== (cursor === 1) ||
        event.type === "tool.execution.requested" ||
        event.type.startsWith("approval.") ||
        (event.type === "run.started" &&
          (event.provider !== job.provider || event.model !== job.model)) ||
        (ended && (cursor !== job.cursor || !terminal)) ||
        (cursor === job.cursor && terminal && !ended) ||
        (event.type === "run.completed" &&
          (job.state !== "completed" ||
            event.result.runId !== job.runId ||
            event.result.provider !== job.provider ||
            event.result.model !== job.model ||
            event.result.session !== undefined)) ||
        (event.type === "run.cancelled" && job.state !== "cancelled") ||
        (event.type === "run.failed" &&
          ((job.state !== "failed" && job.state !== "interrupted") ||
            (job.state === "interrupted" &&
              event.error.outcome !== "uncertain")))
      )
        throw invalid();
      events.push(event);
    }
    if (
      nextCursor !== cursor ||
      cursor > job.cursor ||
      hasMore !== cursor < job.cursor ||
      (hasMore && !events.length)
    )
      throw invalid();
    return { job, events, nextCursor, hasMore };
  }
  async createSession(
    input: SessionCreate,
    options: ClientRequestOptions = {},
  ): Promise<SessionSnapshot> {
    const result = SessionSnapshotSchema.safeParse(
      await this.sessionRequest("create", input, options),
    );
    if (
      !result.success ||
      result.data.session.provider !== input.provider ||
      result.data.session.model !== input.model ||
      result.data.session.mode !== input.mode ||
      result.data.session.state !== "ready" ||
      result.data.session.revision !== 0 ||
      result.data.instructions !== input.instructions ||
      JSON.stringify(result.data.history) !==
        JSON.stringify(
          (input.history ?? []).map(({ role, content }) => ({ role, content })),
        )
    )
      throw new DriverError(
        "INVALID_RESPONSE",
        "The conversation receipt does not match its creation request.",
      );
    return result.data;
  }
  async readSession(
    input: SessionIdentity,
    options: ClientRequestOptions = {},
  ): Promise<SessionSnapshot> {
    const result = SessionSnapshotSchema.safeParse(
      await this.sessionRequest("read", input, options),
    );
    if (!result.success || result.data.session.id !== input.id)
      throw new DriverError(
        "INVALID_RESPONSE",
        "The conversation response does not match its identity.",
      );
    return result.data;
  }
  async deleteSession(
    input: SessionIdentity,
    options: ClientRequestOptions = {},
  ): Promise<SessionDeleteResult> {
    const result = SessionDeleteResultSchema.safeParse(
      await this.sessionRequest("delete", input, options),
    );
    if (!result.success || result.data.id !== input.id)
      throw new DriverError(
        "INVALID_RESPONSE",
        "The deletion receipt does not match its conversation.",
      );
    return result.data;
  }
  private async sessionRequest(
    operation: string,
    input: SessionCreate | SessionIdentity,
    options: ClientRequestOptions,
  ): Promise<unknown> {
    const response = await this.request(
      `v1/sessions/${operation}`,
      input,
      options.signal,
    );
    return readResponseJson(response);
  }
  stream(
    request: RunRequest,
    options: ClientRequestOptions = {},
  ): AsyncGenerator<RunEvent> {
    const controller = new AbortController();
    return cancelOnClose(
      this.streamInternal(request, {
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      }),
      controller,
    );
  }

  private async *streamInternal(
    request: RunRequest,
    options: ClientRequestOptions = {},
  ): AsyncGenerator<RunEvent> {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.request("v1/runs", request, signal, true);
      if (
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new DriverError(
          "INVALID_RESPONSE",
          "Expected an SSE response from the driver.",
        );
      }
      const executions = new Set<string>(),
        executionCalls = new Set<string>();
      let sequence = 0,
        runId: string | undefined;
      for await (const data of readSse(response.body)) {
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          throw new DriverError(
            "INVALID_STREAM",
            "The event stream contained malformed JSON.",
          );
        }
        const envelope = envelopeSchema.safeParse(raw);
        if (
          !envelope.success ||
          envelope.data.sequence !== sequence + 1 ||
          (sequence === 0 && envelope.data.type !== "run.started") ||
          (sequence !== 0 && envelope.data.type === "run.started") ||
          (runId !== undefined && envelope.data.runId !== runId)
        )
          throw new DriverError(
            "INVALID_STREAM",
            "The event stream contained an invalid or out-of-order event.",
          );
        runId = envelope.data.runId;
        sequence = envelope.data.sequence;
        if (
          !(RUN_EVENT_TYPES as readonly string[]).includes(envelope.data.type)
        ) {
          if (envelope.data.optional === true) continue;
          throw new DriverError(
            "UNSUPPORTED_EVENT",
            "The host sent an unknown required event type.",
          );
        }
        if (envelope.data.type.startsWith("approval.") && !request.approvals)
          throw new DriverError(
            "UNSUPPORTED_EVENT",
            "Interactive approvals were not selected for this run.",
          );
        if (
          envelope.data.type === "tool.execution.requested" &&
          !request.applicationTools
        )
          throw new DriverError(
            "UNSUPPORTED_EVENT",
            "Application executors were not selected for this run.",
          );
        const payload = eventSchema.safeParse(raw);
        if (!payload.success)
          throw new DriverError(
            "INVALID_STREAM",
            "The event stream contained an invalid event payload.",
          );
        const event: RunEvent = { ...envelope.data, ...payload.data };
        if (
          (event.type === "tool.execution.requested" &&
            (event.execution.runId !== runId ||
              !request.tools?.includes(event.execution.call.name) ||
              !request.applicationTools?.some(
                (definition) => definition.name === event.execution.call.name,
              ))) ||
          (event.type === "approval.requested" &&
            (event.approval.runId !== runId ||
              event.approval.idlePolicy !== request.approvals?.idlePolicy)) ||
          (event.type === "approval.resolved" &&
            event.resolution.runId !== runId) ||
          (event.type === "run.started" &&
            (event.provider !== request.provider ||
              event.model !== request.model)) ||
          (event.type === "run.completed" &&
            (event.result.runId !== runId ||
              !validSessionResult(event.result, request) ||
              event.result.provider !== request.provider ||
              event.result.model !== request.model ||
              Boolean(event.result.retrieval) !== Boolean(request.retrieval) ||
              (event.result.retrieval &&
                !validRetrievalSelection(
                  event.result.retrieval,
                  request.retrieval!,
                ))))
        )
          throw new DriverError(
            "INVALID_STREAM",
            "The event result does not belong to the requested run.",
          );
        if (event.type === "tool.execution.requested") {
          const { executionId, call } = event.execution;
          if (
            executions.has(executionId) ||
            executionCalls.has(call.id) ||
            executions.size >= 2048
          )
            throw new DriverError(
              "INVALID_STREAM",
              "An application tool invocation was repeated or exceeded the run bound.",
            );
          executions.add(executionId);
          executionCalls.add(call.id);
        }
        yield event;
        if (
          ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
        )
          return;
      }
      throw new DriverError(
        "INCOMPLETE_STREAM",
        "The connection closed before a terminal run event.",
      );
    } finally {
      controller.abort();
    }
  }
}

function combineTimeout(
  signal: AbortSignal | undefined,
  milliseconds: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const data = await readLimited(response);
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new DriverError(
      "INVALID_RESPONSE",
      "The driver returned malformed JSON.",
    );
  }
}

/** Handles arbitrary byte boundaries, CRLF, comments, and multi-line SSE data fields. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true }),
    encoder = new TextEncoder();
  let buffer = "",
    fields: string[] = [],
    frameBytes = 0,
    skipLf = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      try {
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
      } catch {
        throw new DriverError(
          "INVALID_STREAM",
          "The event stream is not valid UTF-8.",
        );
      }
      let newline: number;
      while (true) {
        if (skipLf && buffer.length) {
          if (buffer[0] === "\n") buffer = buffer.slice(1);
          skipLf = false;
        }
        newline = buffer.search(/[\r\n]/);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        skipLf = buffer[newline] === "\r";
        buffer = buffer.slice(newline + 1);
        frameBytes += encoder.encode(line).byteLength;
        if (frameBytes > 2_000_000)
          throw new DriverError(
            "RESPONSE_TOO_LARGE",
            "An event exceeded the size limit.",
          );
        if (!line) {
          if (fields.length) yield fields.join("\n");
          fields = [];
          frameBytes = 0;
        } else if (line.startsWith("data:"))
          fields.push(line.slice(5).replace(/^ /, ""));
      }
      if (encoder.encode(buffer).byteLength + frameBytes > 2_000_000)
        throw new DriverError(
          "RESPONSE_TOO_LARGE",
          "An event exceeded the size limit.",
        );
      if (done) {
        if (buffer.trim() || fields.length)
          throw new DriverError(
            "INCOMPLETE_STREAM",
            "The stream ended inside an event.",
          );
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
