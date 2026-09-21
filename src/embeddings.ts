import { createHash } from "node:crypto";
import { z } from "zod";
import { abortable, DriverError, publicError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";
import {
  EmbeddingIdentitySchema,
  type EmbeddingIdentity,
} from "./retrieval-types.js";
import { normalizedVector } from "./vector-store.js";
import type { ExecutionContext, Usage, UsageSource } from "./types.js";

export interface EmbeddingResult {
  vectors: number[][];
  usage?: Usage;
}
export interface EmbeddingAdapter {
  readonly info: EmbeddingIdentity;
  readonly usageSource?: UsageSource;
  embed(
    texts: readonly string[],
    context: ExecutionContext,
  ): Promise<EmbeddingResult>;
}
export interface OpenAIEmbeddingOptions {
  identity: EmbeddingIdentity & { authMode: "api-key" };
  baseUrl: string;
  apiKey: string | (() => string | Promise<string>);
  /** Some older/compatible models require the native dimension and reject this API parameter. */
  sendDimensions?: boolean;
  fetch?: typeof globalThis.fetch;
}

/** OpenAI-compatible POST /embeddings, float encoding. Identity/model/dimensions never fall back. */
export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly usageSource = "provider-response" as const;
  readonly info: EmbeddingIdentity;
  private readonly base: URL;
  constructor(private readonly options: OpenAIEmbeddingOptions) {
    this.info = Object.freeze(EmbeddingIdentitySchema.parse(options.identity));
    if (this.info.authMode !== "api-key")
      throw new Error("API embeddings require an explicit API account.");
    this.base = secureBaseUrl(options.baseUrl);
  }
  async embed(
    texts: readonly string[],
    context: ExecutionContext,
  ): Promise<EmbeddingResult> {
    validateEmbeddingInput(texts);
    const { signal } = context;
    signal.throwIfAborted();
    try {
      const key = await abortable(
        Promise.resolve(
          typeof this.options.apiKey === "function"
            ? this.options.apiKey()
            : this.options.apiKey,
        ),
        signal,
      );
      if (!key)
        throw new DriverError(
          "AUTH_REQUIRED",
          "The configured embedding account has no API credential.",
        );
      const response = await abortable(
        (this.options.fetch ?? globalThis.fetch)(
          new URL("embeddings", this.base),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: this.info.model,
              input: texts,
              encoding_format: "float",
              ...(this.options.sendDimensions === false
                ? {}
                : { dimensions: this.info.dimensions }),
            }),
            signal,
            redirect: "error",
            credentials: "omit",
          },
        ),
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new DriverError(
          response.status === 401 || response.status === 403
            ? "EMBEDDING_AUTH_REJECTED"
            : response.status === 429
              ? "RATE_LIMITED"
              : "EMBEDDING_HTTP_ERROR",
          `The embedding provider returned HTTP ${response.status}. No alternate account or model was attempted.`,
          response.status === 429 || response.status >= 500,
        );
      }
      const parsed = z
        .object({
          object: z.literal("list"),
          model: z.literal(this.info.model),
          data: z
            .array(
              z.object({
                object: z.literal("embedding"),
                index: z
                  .number()
                  .int()
                  .min(0)
                  .max(texts.length - 1),
                embedding: z.array(z.number()).length(this.info.dimensions),
              }),
            )
            .length(texts.length),
          usage: z
            .object({
              prompt_tokens: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              total_tokens: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
            })
            .optional(),
        })
        .safeParse(
          JSON.parse(
            await abortable(
              readLimited(
                response,
                Math.min(
                  32_000_000,
                  4096 + texts.length * (this.info.dimensions * 32 + 256),
                ),
              ),
              signal,
            ),
          ),
        );
      if (
        !parsed.success ||
        new Set(parsed.data.data.map((item) => item.index)).size !==
          texts.length
      )
        throw new DriverError(
          "INVALID_EMBEDDING",
          "The provider returned an invalid embedding response or a different model.",
        );
      const vectors = parsed.data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => normalizedVector(item.embedding, this.info.dimensions));
      signal.throwIfAborted();
      context.reportProgress();
      return {
        vectors,
        ...(parsed.data.usage
          ? { usage: { inputTokens: parsed.data.usage.prompt_tokens } }
          : {}),
      };
    } catch (error) {
      if (signal.aborted || error instanceof DriverError)
        throw publicError(error, signal);
      throw new DriverError(
        "EMBEDDING_FAILED",
        "The embedding request failed. Inspect the host's private diagnostics; no automatic retry was attempted.",
      );
    }
  }
}

/** Reproducible lexical-hash fixture for tests and demos; not a semantic embedding model. */
export class DeterministicEmbeddingAdapter implements EmbeddingAdapter {
  readonly usageSource = "synthetic" as const;
  readonly info: EmbeddingIdentity;
  constructor(dimensions: number) {
    this.info = Object.freeze(
      EmbeddingIdentitySchema.parse({
        providerId: "fixture-embedding",
        vendor: "fixture",
        accountId: "fixture",
        authMode: "none",
        model: "lexical-hash-v1",
        dimensions,
      }),
    );
  }
  async embed(
    texts: readonly string[],
    context: ExecutionContext,
  ): Promise<EmbeddingResult> {
    validateEmbeddingInput(texts);
    const vectors = texts.map((text) => {
      context.signal.throwIfAborted();
      const vector = Array<number>(this.info.dimensions).fill(0);
      for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [
        text,
      ]) {
        const hash = createHash("sha256").update(token).digest();
        const index = hash.readUInt32BE() % vector.length;
        vector[index] = vector[index]! + 1;
      }
      context.reportProgress();
      return normalizedVector(vector, this.info.dimensions);
    });
    return { vectors };
  }
}

export function validateEmbeddingInput(texts: readonly string[]): void {
  if (
    !texts.length ||
    texts.length > 256 ||
    texts.some(
      (text) =>
        typeof text !== "string" ||
        !text.trim() ||
        Buffer.byteLength(text) > 16_384 ||
        Buffer.from(text).toString("utf8") !== text,
    ) ||
    texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 1_048_576
  )
    throw new DriverError(
      "INVALID_RETRIEVAL",
      "Embedding inputs must be nonempty UTF-8 text within the chunk and batch limits.",
    );
}
