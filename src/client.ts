import { z } from "zod";
import { DriverError } from "./errors.js";
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

export interface ClientOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
});
const usageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
const resultSchema = z.object({
  runId: z.string(),
  provider: z.string(),
  model: z.string(),
  text: z.string(),
  output: z.json().optional(),
  usage: usageSchema,
  steps: z.number().int().positive(),
  finishReason: z.enum(["stop", "length"]),
});
const eventSchema = z.discriminatedUnion("type", [
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
    phase: z.enum(["model", "tool"]),
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
  timestamp: z.string(),
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
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  private async request(
    path: string,
    body?: RunRequest,
    signal?: AbortSignal,
    stream = false,
  ): Promise<Response> {
    const response = await this.fetcher(new URL(path, this.base), {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
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
  async protocol(
    options: { signal?: AbortSignal } = {},
  ): Promise<ProtocolInfo> {
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
      .safeParse(JSON.parse(await readLimited(response)));
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
  async providers(
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo[]> {
    const response = await this.request(
      "v1/providers",
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
            usageStatId: z.string().optional(),
            capabilities: z
              .object({
                tools: z.boolean(),
                textStreaming: z.boolean(),
              })
              .catchall(z.boolean()),
          }),
        ),
      })
      .safeParse(JSON.parse(await readLimited(response)));
    if (!result.success)
      throw new DriverError(
        "INVALID_RESPONSE",
        "The driver returned an invalid provider catalog.",
      );
    return result.data.providers;
  }
  async run(
    request: RunRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunResult> {
    for await (const event of this.stream(request, options)) {
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
    request: RunRequest,
    options: { signal?: AbortSignal } = {},
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
        const payload = eventSchema.safeParse(raw);
        if (!payload.success)
          throw new DriverError(
            "INVALID_STREAM",
            "The event stream contained an invalid event payload.",
          );
        const event: RunEvent = { ...envelope.data, ...payload.data };
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

/** Handles arbitrary byte boundaries, CRLF, comments, and multi-line SSE data fields. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    fields: string[] = [],
    frameBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        frameBytes += line.length;
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
      if (buffer.length + frameBytes > 2_000_000)
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
