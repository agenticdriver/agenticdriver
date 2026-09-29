import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { abortable, DriverError, publicError } from "./errors.js";
import {
  validateEmbeddingInput,
  type EmbeddingAdapter,
  type EmbeddingResult,
} from "./embeddings.js";
import {
  EmbeddingIdentitySchema,
  type EmbeddingIdentity,
} from "./retrieval-types.js";
import { normalizedVector } from "./vector-store.js";
import type { ExecutionContext } from "./types.js";

const optionsSchema = z
  .object({
    providerId: EmbeddingIdentitySchema.shape.providerId,
    accountId: EmbeddingIdentitySchema.shape.accountId,
    model: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .max(120),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    dimensions: EmbeddingIdentitySchema.shape.dimensions,
    cacheDirectory: z.string().refine(isAbsolute),
    dtype: z.enum(["q8", "fp32"]).default("q8"),
    pooling: z.enum(["mean", "cls"]).default("mean"),
    maxTokens: z.number().int().min(1).max(512).default(256),
    allowDownload: z.boolean().default(false),
  })
  .strict();
export type LocalEmbeddingOptions = z.input<typeof optionsSchema>;

/** Opt-in CPU inference using a pinned real ONNX model; no API account or fallback. */
export class LocalEmbeddingAdapter implements EmbeddingAdapter {
  readonly usageSource = "adapter-report" as const;
  readonly info: EmbeddingIdentity;
  private readonly options: z.output<typeof optionsSchema>;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(options: LocalEmbeddingOptions) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_EMBEDDING_CONFIG",
        "Local embeddings require an explicit model, immutable revision, dimensions and private absolute cache path.",
      );
    this.options = Object.freeze(parsed.data);
    const {
      providerId,
      accountId,
      model,
      revision,
      dtype,
      pooling,
      dimensions,
    } = this.options;
    this.info = Object.freeze(
      EmbeddingIdentitySchema.parse({
        providerId,
        accountId,
        vendor: "huggingface",
        authMode: "none",
        dimensions,
        // Changing weights, precision or pooling cannot silently reuse an old index.
        model: `${model}:${revision}:${dtype}:${pooling}`,
      }),
    );
  }

  async embed(
    texts: readonly string[],
    context: ExecutionContext,
  ): Promise<EmbeddingResult> {
    const inputs = [...texts];
    validateEmbeddingInput(inputs);
    context.signal.throwIfAborted();
    if (this.pending >= 4)
      throw new DriverError(
        "EMBEDDING_BUSY",
        "The selected local embedding instance has four pending calls.",
        true,
      );
    this.pending++;
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => gate);
    let worker: Worker | undefined;
    try {
      await abortable(previous, context.signal);
      await mkdir(this.options.cacheDirectory, {
        recursive: true,
        mode: 0o700,
      });
      const directory = await lstat(this.options.cacheDirectory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((directory.mode & 0o077) !== 0 ||
            directory.uid !== process.getuid?.()))
      )
        throw new DriverError(
          "EMBEDDING_CACHE_UNSAFE",
          "Use a private host-owned model-cache directory.",
        );
      const runtimeName = "@huggingface/transformers";
      let runtimeUrl: string;
      try {
        runtimeUrl = import.meta.resolve(runtimeName);
        const metadata = JSON.parse(
          await readFile(new URL("../package.json", runtimeUrl), "utf8"),
        );
        if (metadata.version !== "4.3.0")
          throw new Error("Unsupported runtime version");
      } catch {
        throw new DriverError(
          "EMBEDDING_RUNTIME_REQUIRED",
          "Install the optional @huggingface/transformers@4.3.0 runtime on the execution host.",
        );
      }
      context.signal.throwIfAborted();
      worker = new Worker(
        new URL("./local-embedding-worker.js", import.meta.url),
        {
          workerData: { options: this.options, texts: inputs, runtimeUrl },
          // No provider keys, Hub token, native account home or NODE_OPTIONS inherited.
          env: {
            PATH: process.env.PATH ?? "",
            HOME: this.options.cacheDirectory,
          },
          execArgv: [],
          stdout: true,
          stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      // Native/runtime diagnostics may include supplied text or private paths.
      worker.stdout?.resume();
      worker.stderr?.resume();
      const selected = worker;
      const result = await abortable(
        new Promise<EmbeddingResult>((resolve, reject) => {
          selected.on("message", (message: unknown) => {
            try {
              const value = z
                .object({
                  type: z.enum(["progress", "result", "error"]),
                  vectors: z
                    .array(z.array(z.number()).length(this.info.dimensions))
                    .length(inputs.length)
                    .optional(),
                  inputTokens: z
                    .number()
                    .int()
                    .nonnegative()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
                  code: z
                    .enum([
                      "EMBEDDING_INPUT_TOO_LONG",
                      "EMBEDDING_MODEL_UNAVAILABLE",
                      "EMBEDDING_FAILED",
                    ])
                    .optional(),
                })
                .strict()
                .parse(message);
              if (value.type === "progress") context.reportProgress();
              else if (value.type === "error")
                reject(
                  new DriverError(
                    value.code ?? "EMBEDDING_FAILED",
                    value.code === "EMBEDDING_INPUT_TOO_LONG"
                      ? "An input exceeds the selected local model token limit. Shorten the chunks; no text was truncated."
                      : "The selected local embedding model could not run. Check its pinned files and optional runtime; no fallback was attempted.",
                  ),
                );
              else {
                if (!value.vectors || value.inputTokens === undefined)
                  throw new Error("Missing local result");
                resolve({
                  vectors: value.vectors.map((v) =>
                    normalizedVector(v, this.info.dimensions),
                  ),
                  usage: { inputTokens: value.inputTokens },
                });
              }
            } catch {
              reject(
                new DriverError(
                  "INVALID_EMBEDDING",
                  "The selected local runtime returned invalid vectors.",
                ),
              );
            }
          });
          selected.once("error", () =>
            reject(
              new DriverError(
                "EMBEDDING_FAILED",
                "The selected local embedding worker failed.",
              ),
            ),
          );
          selected.once("exit", () =>
            reject(
              new DriverError(
                "EMBEDDING_FAILED",
                "The selected local embedding worker exited before returning vectors.",
              ),
            ),
          );
        }),
        context.signal,
      );
      context.signal.throwIfAborted();
      return result;
    } catch (error) {
      throw publicError(error, context.signal);
    } finally {
      // Each batch owns its worker. Cancellation also releases the model/runtime.
      try {
        await worker?.terminate();
      } finally {
        this.pending--;
        release();
      }
    }
  }
}
