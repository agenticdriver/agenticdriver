import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { secureBaseUrl, readLimited } from "./security.js";
import {
  UsageSchema,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
  type ProviderTurn,
  type ProviderInspection,
} from "./types.js";

/** Host-side adapter ABI, independent from the HTTP wire version and package release. */
export const PROVIDER_CONTRACT_VERSION = "1.0" as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/);
const version = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .max(100);
export const ProviderExtensionManifestSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    version,
    contractVersion: z.literal(PROVIDER_CONTRACT_VERSION),
    vendor: id,
    authMode: z.enum(["api-key", "cli-session", "none"]),
    usageSource: z.enum([
      "provider-response",
      "cli-report",
      "adapter-report",
      "synthetic",
    ]),
    capabilities: z
      .object({ tools: z.boolean(), textStreaming: z.boolean() })
      .catchall(z.boolean()),
  })
  .strict();
export type ProviderExtensionManifest = z.infer<
  typeof ProviderExtensionManifestSchema
>;
export interface ProviderExtensionOptions {
  id: string;
  name?: string;
  models: readonly string[];
  /** Trusted host settings, never copied from a RunRequest. Validate these in the factory. */
  settings?: Readonly<Record<string, unknown>>;
  /** Resolve only explicitly configured aliases; propagate the current operation's signal. */
  getSecret?(alias: string, signal: AbortSignal): Promise<string>;
}
export interface ProviderImplementation {
  inspect?(context: { signal: AbortSignal }): Promise<ProviderInspection>;
  complete(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderTurn>;
}
export interface ProviderExtension {
  readonly manifest: Readonly<ProviderExtensionManifest>;
  create(options: ProviderExtensionOptions): ProviderAdapter;
}
const turnSchema = z
  .object({
    text: z.string(),
    toolCalls: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
            arguments: z.record(z.string(), z.json()),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    usage: UsageSchema.optional(),
    native: z.json().optional(),
    finishReason: z.enum(["stop", "length"]).optional(),
  })
  .strict();
const invalid = () =>
  new DriverError(
    "INVALID_PROVIDER_RESULT",
    "The extension returned a result outside its declared adapter contract.",
  );

/** Static trusted-code registration. No package name, module path or endpoint is loaded from a run. */
export function defineProviderExtension(
  input: ProviderExtensionManifest,
  factory: (options: ProviderExtensionOptions) => ProviderImplementation,
): ProviderExtension {
  const parsed = ProviderExtensionManifestSchema.safeParse(input);
  if (!parsed.success || typeof factory !== "function")
    throw new DriverError(
      "INVALID_PROVIDER_EXTENSION",
      "Declare a versioned provider extension for adapter contract 1.0 and its capabilities.",
    );
  const manifest = Object.freeze({
    ...parsed.data,
    capabilities: Object.freeze(parsed.data.capabilities),
  });
  return Object.freeze({
    manifest,
    create(options: ProviderExtensionOptions): ProviderAdapter {
      const instance = z
        .object({
          id,
          name: z.string().min(1).max(100).optional(),
          models: z
            .array(model)
            .min(1)
            .max(1000)
            .refine((models) => new Set(models).size === models.length),
        })
        .safeParse(options);
      if (!instance.success)
        throw new DriverError(
          "INVALID_PROVIDER_EXTENSION",
          "Configure a provider instance ID and an explicit, unique model allowlist.",
        );
      let settings: Record<string, unknown>;
      try {
        settings = z.record(z.string(), z.json()).parse(options.settings ?? {});
        if (Buffer.byteLength(JSON.stringify(settings)) > 128_000)
          throw new Error();
      } catch {
        throw new DriverError(
          "INVALID_PROVIDER_EXTENSION",
          "Provider settings must be bounded, serializable host configuration.",
        );
      }
      const implementation = factory({
        ...instance.data,
        models: Object.freeze([...instance.data.models]),
        settings,
        getSecret: options.getSecret,
      });
      if (
        !implementation ||
        typeof implementation.complete !== "function" ||
        (implementation.inspect !== undefined &&
          typeof implementation.inspect !== "function")
      )
        throw new DriverError(
          "INVALID_PROVIDER_EXTENSION",
          "The extension factory must return complete and an optional inspect implementation.",
        );
      const adapter: ProviderAdapter = {
        usageSource: manifest.usageSource,
        info: {
          id: instance.data.id,
          name: instance.data.name ?? manifest.name,
          vendor: manifest.vendor,
          authMode: manifest.authMode,
          models: [...instance.data.models],
          capabilities: { ...manifest.capabilities },
        },
        ...(implementation.inspect
          ? {
              inspect: (context: { signal: AbortSignal }) =>
                abortable(
                  Promise.resolve().then(() => {
                    context.signal.throwIfAborted();
                    return implementation.inspect!(context);
                  }),
                  context.signal,
                ),
            }
          : {}),
        async complete(request, context) {
          if (!instance.data.models.includes(request.model))
            throw new DriverError(
              "UNSUPPORTED_MODEL",
              "The model is not enabled for this extension instance.",
            );
          if (request.tools.length && !manifest.capabilities.tools)
            throw new DriverError(
              "UNSUPPORTED_TOOLS",
              "This extension does not declare tool support.",
            );
          let streamed = "",
            bytes = 0,
            active = true,
            invalidStream = false;
          try {
            const raw = await abortable(
              Promise.resolve().then(() => {
                context.signal.throwIfAborted();
                return implementation.complete(request, {
                  ...context,
                  reportProgress: () => {
                    if (active && !context.signal.aborted)
                      context.reportProgress();
                  },
                  emitText: (text) => {
                    if (!active || context.signal.aborted) return;
                    if (
                      typeof text !== "string" ||
                      !manifest.capabilities.textStreaming
                    ) {
                      invalidStream = true;
                      throw invalid();
                    }
                    bytes += Buffer.byteLength(text);
                    if (bytes > 2_000_000) {
                      invalidStream = true;
                      throw invalid();
                    }
                    streamed += text;
                    context.emitText(text);
                  },
                });
              }),
              context.signal,
            );
            const result = turnSchema.safeParse(raw);
            if (
              !result.success ||
              invalidStream ||
              (streamed && streamed !== result.data.text) ||
              (result.data.toolCalls?.length && !manifest.capabilities.tools) ||
              Buffer.byteLength(JSON.stringify(result.data)) > 2_000_000
            )
              throw invalid();
            return result.data;
          } finally {
            active = false;
          }
        },
      };
      // Callers cannot broaden the model/capability policy after registration.
      Object.freeze(adapter.info.models);
      Object.freeze(adapter.info.capabilities);
      Object.freeze(adapter.info);
      return Object.freeze(adapter);
    },
  });
}

/** Validate the operator's base URL before resolving credentials. Fetches must also prohibit redirects. */
export const providerEndpoint = secureBaseUrl;
/** A bounded UTF-8 reader for independent adapters; never include returned provider bodies in public errors. */
export const readProviderResponse = readLimited;
export type {
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
  ProviderTurn,
  ProviderInspection,
} from "./types.js";
