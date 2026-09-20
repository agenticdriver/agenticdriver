import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { abortable, DriverError, publicError } from "./errors.js";
import { RunRequestSchema } from "./types.js";
import { withProgress } from "./progress.js";
import type {
  EventPayload,
  ExecutionContext,
  Json,
  ProviderAdapter,
  ProviderMessage,
  RunEvent,
  RunOptions,
  RunRequest,
  RunResult,
  Tool,
  ToolCall,
  Usage,
  UsageRecord,
} from "./types.js";

export interface DriverOptions {
  providers: ProviderAdapter[];
  tools?: Tool[];
  approve?: (
    call: ToolCall,
    context: ExecutionContext,
  ) => Promise<boolean> | boolean;
  onUsage?: (record: UsageRecord) => Promise<void> | void;
  onTelemetryError?: (error: unknown) => void;
  /** Host limits always win over larger caller limits. */
  limits?: {
    maxSteps?: number;
    idleTimeoutMs?: number;
    maxOutputTokens?: number;
  };
}

export class AgenticDriver {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly tools = new Map<
    string,
    { tool: Tool; validate: ValidateFunction }
  >();
  private readonly ajv = new Ajv({
    allErrors: false,
    strict: false,
    validateFormats: false,
  });
  constructor(private readonly options: DriverOptions) {
    for (const provider of options.providers) {
      if (this.providers.has(provider.info.id))
        throw new Error(`Duplicate provider instance: ${provider.info.id}`);
      this.providers.set(provider.info.id, provider);
    }
    for (const tool of options.tools ?? []) {
      if (
        !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tool.name) ||
        this.tools.has(tool.name)
      )
        throw new Error(`Invalid or duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, {
        tool,
        validate: this.ajv.compile(tool.inputSchema),
      });
    }
    for (const [name, limit] of Object.entries(options.limits ?? {})) {
      if (limit === undefined) continue;
      if (
        !Number.isSafeInteger(limit) ||
        limit < (name === "idleTimeoutMs" ? 0 : 1) ||
        (name === "idleTimeoutMs" && limit > 2_147_483_647)
      )
        throw new Error(
          "Host limits must be valid integers; only idleTimeoutMs may be zero (disabled).",
        );
    }
  }

  listProviders() {
    return structuredClone([...this.providers.values()].map((p) => p.info));
  }

  /** Also used by the remote host to reject invalid runs before sending SSE headers. */
  validate(input: RunRequest): RunRequest {
    const parsed = RunRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_REQUEST",
        "The run request does not match the v1 schema.",
      );
    const request = parsed.data;
    const provider = this.providers.get(request.provider);
    if (!provider)
      throw new DriverError(
        "UNKNOWN_PROVIDER",
        "The provider instance is not configured.",
      );
    if (provider.info.models && !provider.info.models.includes(request.model))
      throw new DriverError(
        "UNSUPPORTED_MODEL",
        "The model is not enabled for this provider instance.",
      );
    if (request.tools?.length && !provider.info.capabilities.tools)
      throw new DriverError(
        "UNSUPPORTED_TOOLS",
        "This adapter does not support application tools.",
      );
    if (new Set(request.tools).size !== (request.tools?.length ?? 0))
      throw new DriverError("INVALID_REQUEST", "Tool names must be unique.");
    for (const name of request.tools ?? [])
      if (!this.tools.has(name))
        throw new DriverError(
          "UNKNOWN_TOOL",
          "A requested tool is not registered on this host.",
        );
    if (request.outputSchema) this.outputValidator(request.outputSchema);
    return request;
  }

  private outputValidator(schema: Record<string, unknown>): ValidateFunction {
    try {
      return new Ajv({ strict: false, validateFormats: false }).compile(schema);
    } catch {
      throw new DriverError(
        "INVALID_SCHEMA",
        "The output schema must be a self-contained JSON Schema (draft-07).",
      );
    }
  }

  async run(input: RunRequest, options: RunOptions = {}): Promise<RunResult> {
    for await (const event of this.stream(input, options)) {
      if (event.type === "run.completed") return event.result;
      if (event.type === "run.failed" || event.type === "run.cancelled")
        throw new DriverError(
          event.error.code,
          event.error.message,
          event.error.retryable,
        );
    }
    throw new DriverError(
      "INCOMPLETE_STREAM",
      "The run ended without a result.",
    );
  }

  async *stream(
    input: RunRequest,
    options: RunOptions = {},
  ): AsyncGenerator<RunEvent> {
    const request = this.validate(input);
    const provider = this.providers.get(request.provider)!;
    const runId = randomUUID(),
      startedAt = Date.now();
    const controller = new AbortController();
    const idleLimits = [
      request.idleTimeoutMs,
      this.options.limits?.idleTimeoutMs,
    ].filter((value): value is number => value !== undefined && value > 0);
    const idleTimeoutMs = idleLimits.length ? Math.min(...idleLimits) : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reportProgress = () => {
      if (!idleTimeoutMs || controller.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            new DriverError(
              "IDLE_TIMEOUT",
              "The run stopped because no model or tool progress arrived within the configured inactivity timeout.",
              true,
            ),
          ),
        idleTimeoutMs,
      );
    };
    reportProgress();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const context: ExecutionContext = {
      runId,
      signal,
      subject: options.subject ?? "local",
      reportProgress,
    };
    let sequence = 0,
      usage: Usage = {},
      turns = 0;
    let status: UsageRecord["status"] = "cancelled";
    const event = (payload: EventPayload): RunEvent => ({
      ...payload,
      runId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
    });
    const messages: ProviderMessage[] = [
      ...(request.history ?? []),
      { role: "user", content: request.input },
    ];
    const selectedTools = (request.tools ?? []).map((name) =>
      this.tools.get(name)!,
    );
    const maxSteps = Math.min(
      request.maxSteps ?? 8,
      this.options.limits?.maxSteps ?? 64,
    );
    const maxOutputTokens = Math.min(
      request.maxOutputTokens ?? 4096,
      this.options.limits?.maxOutputTokens ?? 65_536,
    );
    const validateOutput = request.outputSchema
      ? this.outputValidator(request.outputSchema)
      : undefined;
    const instructions = [
      request.instructions,
      request.outputSchema
        ? `Return only JSON matching this JSON Schema: ${JSON.stringify(request.outputSchema)}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      signal.throwIfAborted();
      yield event({
        type: "run.started",
        provider: request.provider,
        model: request.model,
      });
      const callIds = new Set<string>();
      for (let step = 1; step <= maxSteps; step++) {
        signal.throwIfAborted();
        yield event({ type: "step.started", step });
        signal.throwIfAborted();
        const { value: turn, streamed } = yield* withProgress(
          (providerContext) =>
            provider.complete(
              {
                model: request.model,
                instructions,
                messages,
                tools: selectedTools.map(({ tool }) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
                maxOutputTokens,
              },
              providerContext,
            ),
          context,
          "model",
          (error) => controller.abort(error),
          event,
        );
        signal.throwIfAborted();
        usage = sumUsage(usage, turn.usage ?? {}, turns++ === 0);
        if (turn.usage)
          yield event({ type: "usage.reported", step, usage: turn.usage });
        if (turn.text && !streamed)
          yield event({ type: "text.delta", text: turn.text });
        const calls = turn.toolCalls ?? [];
        if (!calls.length) {
          let output: Json | undefined;
          if (validateOutput) {
            try {
              output = JSON.parse(turn.text) as Json;
            } catch {
              throw new DriverError(
                "INVALID_OUTPUT",
                "The model did not return valid JSON.",
              );
            }
            if (!validateOutput(output))
              throw new DriverError(
                "INVALID_OUTPUT",
                "The model output did not match the requested schema.",
              );
          }
          signal.throwIfAborted();
          status = "completed";
          yield event({
            type: "run.completed",
            result: {
              runId,
              provider: request.provider,
              model: request.model,
              text: turn.text,
              ...(output === undefined ? {} : { output }),
              usage,
              steps: step,
              finishReason: turn.finishReason ?? "stop",
            },
          });
          return;
        }
        if (step === maxSteps)
          throw new DriverError(
            "STEP_LIMIT",
            "The run reached its maximum number of model steps.",
          );
        if (calls.length > 32)
          throw new DriverError(
            "TOOL_LIMIT",
            "The provider requested too many tool calls in one step.",
          );
        // Validate the whole batch before any tool can produce a side effect.
        for (const call of calls) {
          const entry = selectedTools.find(
            ({ tool }) => tool.name === call.name,
          );
          if (!entry)
            throw new DriverError(
              "TOOL_NOT_ALLOWED",
              "The provider requested a tool outside this run's allowlist.",
            );
          if (!call.id || callIds.has(call.id))
            throw new DriverError(
              "INVALID_TOOL_CALL",
              "The provider returned a missing or repeated tool call ID.",
            );
          callIds.add(call.id);
          if (!entry.validate(call.arguments))
            throw new DriverError(
              "INVALID_TOOL_ARGUMENTS",
              "Tool arguments did not match the registered schema.",
            );
        }
        messages.push({
          role: "assistant",
          content: turn.text,
          toolCalls: calls,
          native: turn.native,
        });
        for (const call of calls) {
          signal.throwIfAborted();
          const { tool } = this.tools.get(call.name)!;
          yield event({ type: "tool.called", call });
          signal.throwIfAborted();
          if (
            tool.requiresApproval &&
            (!this.options.approve ||
              !(await abortable(
                Promise.resolve(this.options.approve(call, context)),
                signal,
              )))
          )
            throw new DriverError(
              "APPROVAL_REQUIRED",
              "The host did not approve this tool call.",
            );
          signal.throwIfAborted();
          let output: Json;
          try {
            output = (yield* withProgress(
              (toolContext) => tool.execute(call.arguments, toolContext),
              context,
              "tool",
              (error) => controller.abort(error),
              event,
            )).value;
          } catch (error) {
            if (signal.aborted) throw error;
            throw new DriverError("TOOL_FAILED", "An application tool failed.");
          }
          const encoded = JSON.stringify(output);
          if (encoded === undefined || Buffer.byteLength(encoded) > 1_000_000)
            throw new DriverError(
              "TOOL_OUTPUT_LIMIT",
              "Tool output must be JSON and at most 1 MB.",
            );
          signal.throwIfAborted();
          messages.push({
            role: "tool",
            content: encoded,
            callId: call.id,
            name: call.name,
          });
          yield event({ type: "tool.completed", callId: call.id, output });
        }
      }
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed";
      yield event({
        type: status === "cancelled" ? "run.cancelled" : "run.failed",
        error: publicError(error, signal).toJSON(),
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      try {
        // Keep telemetry optional and bounded; a failed sink must not replay a successful run.
        const record: UsageRecord = {
          schema: "agenticdriver.usage.v1",
          runId,
          subject: context.subject,
          provider: provider.info.id,
          vendor: provider.info.vendor,
          model: request.model,
          authMode: provider.info.authMode,
          status,
          usage,
          durationMs: Date.now() - startedAt,
          metadata: request.metadata ?? {},
        };
        if (this.options.onUsage)
          await abortable(
            Promise.resolve(this.options.onUsage(record)),
            AbortSignal.timeout(2000),
          );
      } catch (error) {
        try {
          this.options.onTelemetryError?.(error);
        } catch {
          /* Never replace the run outcome. */
        }
      }
    }
  }
}

function sumUsage(previous: Usage, next: Usage, first: boolean): Usage {
  const result: Usage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "costUsd",
  ] as const) {
    const value = next[key],
      prior = previous[key];
    if (
      value !== undefined &&
      Number.isFinite(value) &&
      value >= 0 &&
      (first || prior !== undefined)
    )
      result[key] = (first ? 0 : prior!) + value;
  }
  return result;
}
