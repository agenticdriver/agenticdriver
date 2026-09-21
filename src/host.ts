import { constants } from "node:fs";
import { ApplicationToolGrantSchema } from "./tool-types.js";
import {
  SessionOperationSchema,
  SessionOptionsSchema,
} from "./session-types.js";
import { mkdir, open, readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import { AgenticDriver, type DriverOptions } from "./driver.js";
import { AgenticClient } from "./client.js";
import { DriverError } from "./errors.js";
import { FileOperationStore } from "./operations.js";
import { isLoopback, secureBaseUrl } from "./security.js";
import {
  anthropic,
  claudeCode,
  codex,
  gemini,
  geminiCli,
  mockProvider,
  openai,
  openaiCompatible,
  xai,
} from "./providers/index.js";
import {
  secretResolver,
  SecretReferenceSchema,
  singleLineSecret,
  type SecretResolver,
} from "./secrets.js";
import { UsageStatClient, jsonlUsageSink } from "./usagestat.js";
import { ContextMediaTypeSchema } from "./context-types.js";
import { validateInputMediaTypes } from "./providers/http.js";
import { UsageIdSchema, UsageOptionsSchema } from "./usage.js";
import type { ProviderAdapter } from "./types.js";
import type { ServerOptions } from "./server.js";
export { SecretReferenceSchema, secretResolver } from "./secrets.js";
export type { SecretReference, SecretResolver } from "./secrets.js";

const instance = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/);
const common = {
  id: instance,
  accountId: UsageIdSchema.optional(),
  name: z.string().min(1).max(100).optional(),
  models: z.array(model).min(1).max(1000),
};
const api = z
  .object({
    ...common,
    kind: z.enum(["openai", "anthropic", "gemini", "xai", "openai-compatible"]),
    apiKeyRef: SecretReferenceSchema,
    inputMediaTypes: z
      .record(model, z.array(ContextMediaTypeSchema).max(6))
      .optional(),
    baseUrl: z.string().url().optional(),
  })
  .strict();
const cli = z
  .object({
    ...common,
    kind: z.enum(["codex", "claude-code", "gemini-cli"]),
    accountDirectory: z.string().min(1).optional(),
    binary: z.string().min(1).optional(),
  })
  .strict();
export const HostConfigSchema = z
  .object({
    version: z.literal(1),
    usage: UsageOptionsSchema.omit({ accounts: true })
      .extend({ hostId: UsageIdSchema })
      .optional(),
    listen: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(0).max(65_535).default(7433),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 7433 }),
    clientUrl: z.string().url().optional(),
    tls: z
      .object({ certFile: z.string().min(1), keyRef: SecretReferenceSchema })
      .strict()
      .optional(),
    providers: z
      .array(
        z.union([
          api,
          cli,
          z.object({ ...common, kind: z.literal("mock") }).strict(),
        ]),
      )
      .min(1)
      .max(32),
    tokens: z
      .array(
        z
          .object({
            id: instance,
            subject: z.string().min(1).max(128),
            tokenRef: SecretReferenceSchema,
            retrieval: z
              .object({
                search: z
                  .array(
                    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
                  )
                  .max(1000)
                  .optional(),
                index: z
                  .array(
                    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
                  )
                  .max(1000)
                  .optional(),
                delete: z
                  .array(
                    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
                  )
                  .max(1000)
                  .optional(),
              })
              .strict()
              .optional(),
            providers: z.array(instance).max(32),
            sessions: z.array(SessionOperationSchema).max(4).optional(),
            applicationTools: z
              .array(ApplicationToolGrantSchema)
              .max(32)
              .optional(),
            approveTools: z
              .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/))
              .max(32)
              .optional(),
            tools: z
              .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/))
              .max(32)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    applicationTools: z
      .object({
        enabled: z.literal(true),
        requireApproval: z.boolean().optional(),
        maxPending: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    sessions: SessionOptionsSchema.optional(),
    approvals: z
      .object({
        interactive: z.literal(true),
        allowIdlePause: z.boolean().optional(),
        maxPending: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    allowedOrigins: z.array(z.string().url()).max(100).optional(),
    operations: z
      .object({
        directory: z.string().min(1),
        maxRecordBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        maxBytes: z.number().int().min(1).max(33_554_432).optional(),
        maxTextBytes: z.number().int().min(1).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    usageLog: z.string().min(1).optional(),
    usagestat: z
      .object({
        url: z.string().url(),
        tokenRef: SecretReferenceSchema,
        ingestionTimeoutMs: z.number().int().min(100).max(1500).optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxSteps: z.number().int().min(1).max(64).optional(),
        maxOutputTokens: z.number().int().min(1).max(65_536).optional(),
        idleTimeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
        maxAttempts: z.number().int().min(1).max(5).optional(),
      })
      .strict()
      .optional(),
    concurrency: z
      .object({
        total: z.number().int().positive().optional(),
        perSubject: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HostConfig = z.infer<typeof HostConfigSchema>;
export function defaultConfigPath(): string {
  if (process.env.AGENTICDRIVER_CONFIG)
    return resolve(process.env.AGENTICDRIVER_CONFIG);
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "agenticdriver", "config.json");
}
export function validateHostConfig(input: unknown): HostConfig {
  const parsed = HostConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_CONFIG",
      "The host configuration does not match the version 1 schema. Check provider types, model IDs and secret references.",
    );
  const config = parsed.data;
  for (const provider of config.providers) {
    if ("apiKeyRef" in provider)
      validateInputMediaTypes(
        provider,
        !["xai", "openai-compatible"].includes(provider.kind),
      );
  }
  if (config.usagestat) {
    secureBaseUrl(config.usagestat.url);
    if (
      !config.usage?.hostId ||
      config.providers.some((provider) => !provider.accountId)
    )
      throw new DriverError(
        "USAGE_IDENTITY_REQUIRED",
        "Usagestat ingestion requires a persistent usage.hostId and an accountId on every provider instance.",
      );
  }
  if (config.providers.some((p) => p.accountId) && !config.usage?.hostId)
    throw new DriverError(
      "USAGE_IDENTITY_REQUIRED",
      "Account bindings require a persistent usage.hostId in the host configuration.",
    );
  if (
    new Set(config.providers.map((p) => p.id)).size !==
      config.providers.length ||
    new Set(config.tokens.map((t) => t.id)).size !== config.tokens.length
  )
    throw new DriverError(
      "INVALID_CONFIG",
      "Provider and token instance IDs must be unique.",
    );
  if (
    config.tokens.some((t) =>
      t.providers.some((id) => !config.providers.some((p) => p.id === id)),
    )
  )
    throw new DriverError(
      "INVALID_CONFIG",
      "A token references a provider instance that is not configured.",
    );
  if (!isLoopback(config.listen.host) && !config.tls)
    throw new DriverError(
      "TLS_REQUIRED",
      "A non-loopback listener requires a TLS certificate and private-key reference.",
    );
  if (config.clientUrl) secureBaseUrl(config.clientUrl);
  for (const provider of config.providers) {
    if (provider.kind === "openai-compatible" && !provider.baseUrl)
      throw new DriverError(
        "INVALID_CONFIG",
        "An OpenAI-compatible provider requires an explicit base URL.",
      );
    if ("baseUrl" in provider && provider.baseUrl)
      secureBaseUrl(provider.baseUrl);
  }
  return config;
}
export async function readHostConfig(path: string): Promise<HostConfig> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(1_000_001);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 1_000_000)
      throw new DriverError(
        "INVALID_CONFIG",
        "Host configuration must not exceed 1 MB.",
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, size),
    );
    return validateHostConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof DriverError) throw error;
    throw new DriverError(
      "INVALID_CONFIG",
      "The host configuration could not be read. Run init for a new configuration, or check the selected file.",
    );
  } finally {
    await handle?.close();
  }
}

export function configuredDriver(
  config: HostConfig,
  configPath: string,
  options: {
    secrets?: SecretResolver;
    tools?: DriverOptions["tools"];
    approve?: DriverOptions["approve"];
    onApprovalAudit?: NonNullable<DriverOptions["approvals"]>["onAudit"];
    onTelemetryError?: DriverOptions["onTelemetryError"];
    context?: DriverOptions["context"];
    retrieval?: DriverOptions["retrieval"];
    ingestion?: DriverOptions["ingestion"];
  } = {},
): AgenticDriver {
  config = validateHostConfig(config);
  const directory = dirname(resolve(configPath)),
    secrets = options.secrets ?? secretResolver(directory);
  const providers = config.providers.map((p): ProviderAdapter => {
    const shared = { id: p.id, name: p.name, models: [...p.models] };
    if (p.kind === "mock") {
      const adapter = mockProvider();
      return {
        ...adapter,
        info: { ...adapter.info, ...shared, name: p.name ?? adapter.info.name },
        inspect: async () => ({
          code: "CATALOG_AVAILABLE",
          models: [...p.models],
          complete: true,
        }),
      };
    }
    if ("apiKeyRef" in p) {
      const values = {
        ...shared,
        baseUrl: p.baseUrl,
        inputMediaTypes: p.inputMediaTypes,
        apiKey: async () => {
          const value = await secrets(p.apiKeyRef);
          return value.trim()
            ? singleLineSecret(async () => value, p.apiKeyRef)
            : "";
        },
      };
      if (p.kind === "openai-compatible")
        return openaiCompatible({ ...values, baseUrl: p.baseUrl! });
      return { openai, anthropic, gemini, xai }[p.kind](values);
    }
    return { codex, "claude-code": claudeCode, "gemini-cli": geminiCli }[
      p.kind
    ]({
      ...shared,
      binary: p.binary,
      accountDirectory: p.accountDirectory
        ? resolve(directory, p.accountDirectory)
        : undefined,
    });
  });
  const usagePath = config.usageLog
    ? resolve(directory, config.usageLog)
    : undefined;
  const sink = usagePath ? jsonlUsageSink(usagePath) : undefined;
  const backend = config.usagestat
    ? new UsageStatClient({
        url: config.usagestat.url,
        token: () => singleLineSecret(secrets, config.usagestat!.tokenRef, 32),
        ingestionTimeoutMs: config.usagestat.ingestionTimeoutMs,
      }).usageSink()
    : undefined;
  return new AgenticDriver({
    providers,
    usage: {
      ...config.usage,
      accounts: Object.fromEntries(
        config.providers.flatMap((p) =>
          p.accountId ? [[p.id, p.accountId]] : [],
        ),
      ),
    },
    context: { ...options.context, ...config.context },
    retrieval: options.retrieval,
    ingestion: options.ingestion,
    tools: options.tools,
    approve: options.approve,
    applicationTools: config.applicationTools,
    sessions: config.sessions,
    approvals: config.approvals
      ? { ...config.approvals, onAudit: options.onApprovalAudit }
      : undefined,
    limits: config.limits,
    operations: config.operations
      ? new FileOperationStore(
          resolve(directory, config.operations.directory),
          config.operations,
        )
      : undefined,
    onUsage:
      sink || backend
        ? async (record) => {
            const writes = await Promise.allSettled([
              ...(backend ? [backend(record)] : []),
              ...(sink && usagePath
                ? [
                    (async () => {
                      await mkdir(dirname(usagePath), {
                        recursive: true,
                        mode: 0o700,
                      });
                      await sink(record);
                    })(),
                  ]
                : []),
            ]);
            if (writes.some((result) => result.status === "rejected"))
              throw new DriverError(
                "USAGE_CAPTURE_FAILED",
                "A configured usage sink did not acknowledge capture. Reconcile the existing run; do not repeat it.",
              );
          }
        : undefined,
    onTelemetryError:
      options.onTelemetryError ??
      (() => {
        process.stderr.write(
          "agenticdriver: usage capture was not acknowledged; reconcile the existing run in Usagestat.\n",
        );
      }),
  });
}

export async function configuredServer(
  config: HostConfig,
  configPath: string,
  secrets: SecretResolver = secretResolver(dirname(resolve(configPath))),
): Promise<ServerOptions> {
  config = validateHostConfig(config);
  const tokens = await Promise.all(
    config.tokens.map(async (entry) => ({
      token: await singleLineSecret(secrets, entry.tokenRef, 32),
      subject: entry.subject,
      providers: entry.providers,
      tools: entry.tools,
      approveTools: entry.approveTools,
      applicationTools: entry.applicationTools,
      sessions: entry.sessions,
      retrieval: entry.retrieval,
    })),
  );
  if (new Set(tokens.map((entry) => entry.token)).size !== tokens.length)
    throw new DriverError(
      "INVALID_CONFIG",
      "Driver token references must resolve to distinct credentials.",
    );
  let tls: ServerOptions["tls"];
  if (config.tls) {
    try {
      tls = {
        cert: await readFile(resolve(dirname(configPath), config.tls.certFile)),
        key: await secrets(config.tls.keyRef),
      };
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "INVALID_TLS",
        "The configured TLS certificate or private key could not be loaded.",
      );
    }
    if (!tls.key.length)
      throw new DriverError(
        "INVALID_TLS",
        "Supply the TLS private key through its configured reference.",
      );
    try {
      createSecureContext({ ...tls, minVersion: "TLSv1.2" });
    } catch {
      throw new DriverError(
        "INVALID_TLS",
        "The configured TLS certificate and key do not form a usable server identity.",
      );
    }
  }
  return {
    ...config.listen,
    tokens,
    tls,
    allowedOrigins: config.allowedOrigins,
    maxConcurrentRuns: config.concurrency?.total,
    maxConcurrentRunsPerSubject: config.concurrency?.perSubject,
  };
}
export async function configuredClient(
  config: HostConfig,
  configPath: string,
  options: { url?: string; tokenId?: string; secrets?: SecretResolver } = {},
): Promise<AgenticClient> {
  config = validateHostConfig(config);
  const entry = options.tokenId
    ? config.tokens.find((t) => t.id === options.tokenId)
    : config.tokens[0];
  if (!entry)
    throw new DriverError(
      "UNKNOWN_TOKEN",
      "The selected driver token reference is not configured.",
    );
  const host = ["0.0.0.0", "::"].includes(config.listen.host)
    ? "127.0.0.1"
    : config.listen.host;
  const url =
    options.url ??
    config.clientUrl ??
    `${config.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${config.listen.port}`;
  const token = await singleLineSecret(
    options.secrets ?? secretResolver(dirname(resolve(configPath))),
    entry.tokenRef,
    32,
  );
  return new AgenticClient({ url, token });
}
