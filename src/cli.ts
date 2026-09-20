#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  configuredClient,
  configuredDriver,
  configuredServer,
  defaultConfigPath,
  readHostConfig,
  validateHostConfig,
  type HostConfig,
} from "./host.js";
import { DriverError, publicError } from "./errors.js";
import { serve } from "./server.js";

const help = `AgenticDriver — local and secure remote execution host

  agenticdriver init [--config PATH] [--provider KIND --model ID]
  agenticdriver serve [--config PATH] [--host HOST] [--port PORT] [--json]
  agenticdriver status [--config PATH] [--url URL] [--token-id ID] [--refresh] [--json]
  agenticdriver doctor [--config PATH] [--json]
  agenticdriver run --provider ID --model ID [--input TEXT] [--config PATH] [--json]

init also accepts --provider-id, --api-key-env, --base-url, --account-directory,
--binary and --port. It creates a mock configuration unless a provider is selected.
run reads stdin when --input is omitted, and accepts --url, --token-id,
--idempotency-key, --idle-timeout-ms and --max-attempts. Run inactivity timeouts
and provider retries are disabled by default. --json streams JSONL events for run.

Providers: mock, openai, anthropic, gemini, xai, openai-compatible, codex,
claude-code and gemini-cli.

--config overrides AGENTICDRIVER_CONFIG and the OS user configuration directory.
--help shows this help; --version shows the installed package version.
Credentials are referenced by configuration, never printed by diagnostics.
`;
type Values = Record<string, string | boolean | undefined>;
function argument(values: Values, name: string): string | undefined {
  return typeof values[name] === "string"
    ? (values[name] as string)
    : undefined;
}
function numberArgument(values: Values, name: string): number | undefined {
  const value = argument(values, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new DriverError(
      "INVALID_ARGUMENT",
      "Numeric command options must be nonnegative integers.",
    );
  return Number(value);
}
const strings = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { type: "string" as const }]));
function commandOptions(command: string) {
  const common = {
    config: { type: "string" as const },
    json: { type: "boolean" as const },
  };
  if (command === "init")
    return {
      ...common,
      ...strings([
        "provider",
        "provider-id",
        "model",
        "api-key-env",
        "base-url",
        "account-directory",
        "binary",
        "port",
      ]),
    };
  if (command === "serve") return { ...common, ...strings(["host", "port"]) };
  if (command === "doctor") return common;
  if (command === "status")
    return {
      ...common,
      ...strings(["url", "token-id"]),
      refresh: { type: "boolean" as const },
    };
  if (command === "run")
    return {
      ...common,
      ...strings([
        "url",
        "token-id",
        "provider",
        "model",
        "input",
        "idempotency-key",
        "idle-timeout-ms",
        "max-attempts",
      ]),
    };
  throw new DriverError(
    "INVALID_ARGUMENT",
    "Choose init, serve, status, doctor or run. Use --help for command options.",
  );
}
async function initialize(path: string, values: Values) {
  const kind = argument(values, "provider") ?? "mock";
  const id = argument(values, "provider-id") ?? kind;
  const model =
    argument(values, "model") ?? (kind === "mock" ? "demo" : undefined);
  if (!model)
    throw new DriverError(
      "MODEL_REQUIRED",
      "Select an explicit model with --model when initializing a provider.",
    );
  const api = [
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "openai-compatible",
  ].includes(kind);
  const cli = ["codex", "claude-code", "gemini-cli"].includes(kind);
  if (
    (!api && (values["api-key-env"] || values["base-url"])) ||
    (!cli && (values.binary || values["account-directory"]))
  )
    throw new DriverError(
      "INVALID_ARGUMENT",
      "API secret/endpoint options apply to API providers; binary/account-directory options apply to native CLI providers.",
    );
  const filename = `driver-${randomUUID()}.token`,
    tokenRef = join("credentials", filename);
  const provider = {
    kind,
    id,
    models: [model],
    ...(api
      ? {
          apiKeyRef: {
            env:
              argument(values, "api-key-env") ??
              (
                {
                  openai: "OPENAI_API_KEY",
                  anthropic: "ANTHROPIC_API_KEY",
                  gemini: "GEMINI_API_KEY",
                  xai: "XAI_API_KEY",
                } as Record<string, string>
              )[kind] ??
              "PROVIDER_API_KEY",
          },
          ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
        }
      : {}),
    ...(cli
      ? {
          binary: argument(values, "binary"),
          accountDirectory: argument(values, "account-directory"),
        }
      : {}),
  };
  const config = validateHostConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: numberArgument(values, "port") ?? 7433 },
    providers: [provider],
    tokens: [
      {
        id: "local-app",
        subject: "local-app",
        tokenRef: { file: tokenRef },
        providers: [id],
        tools: [],
      },
    ],
    operations: { directory: "state/operations" },
  });
  const directory = dirname(path),
    credential = join(directory, tokenRef),
    temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  let credentialCreated = false,
    published = false;
  try {
    await mkdir(join(directory, "credentials"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(credential, randomBytes(32).toString("base64url") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    credentialCreated = true;
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, path);
    published = true;
  } catch (error) {
    throw new DriverError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "CONFIG_EXISTS"
        : "CONFIG_WRITE_FAILED",
      "Configuration was not replaced. Choose a new config path, or check directory access.",
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (credentialCreated && !published)
      await rm(credential, { force: true }).catch(() => {});
  }
  return {
    configPath: path,
    provider: id,
    model,
    tokenFile: credential,
    next: "Run serve, then status or an explicit run command using this configuration.",
  };
}
async function inputText(value?: string): Promise<string> {
  if (value !== undefined) return value;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 400_000)
      throw new DriverError(
        "INPUT_TOO_LARGE",
        "Input exceeds the text request limit.",
      );
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new DriverError("INVALID_INPUT", "Input must be UTF-8 text.");
  }
}
function print(value: unknown, json: boolean) {
  if (json) process.stdout.write(JSON.stringify(value) + "\n");
  else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    process.stdout.write(help);
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(
      (
        JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version + "\n",
    );
    return 0;
  }
  const command = args[0]!;
  let values: Values;
  try {
    values = parseArgs({
      args: args.slice(1),
      options: commandOptions(command),
      strict: true,
      allowPositionals: false,
    }).values as Values;
  } catch (error) {
    if (error instanceof DriverError) throw error;
    throw new DriverError(
      "INVALID_ARGUMENT",
      "Unknown or malformed command options. Use --help for usage.",
    );
  }
  const path = resolve(argument(values, "config") ?? defaultConfigPath()),
    json = values.json === true;
  if (command === "init") {
    print(await initialize(path, values), json);
    return 0;
  }
  let config: HostConfig = await readHostConfig(path);
  if (command === "serve") {
    config = validateHostConfig({
      ...config,
      listen: {
        host: argument(values, "host") ?? config.listen.host,
        port: numberArgument(values, "port") ?? config.listen.port,
      },
    });
    const server = await serve(
      configuredDriver(config, path),
      await configuredServer(config, path),
    );
    print(
      {
        event: "listening",
        url: server.url,
        configPath: path,
        pid: process.pid,
      },
      json,
    );
    let closing = false;
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        if (closing) return;
        closing = true;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.close().then(resolve, reject);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  }
  if (command === "doctor") {
    const server = await configuredServer(config, path);
    const providers = await configuredDriver(config, path).discoverProviders({
      refresh: true,
    });
    const ok = providers.every(
      (p) => p.health?.status === "ready" || p.health?.status === "unknown",
    );
    print(
      {
        ok,
        configuration: "valid",
        listener: {
          host: server.host,
          port: server.port,
          tls: Boolean(server.tls),
        },
        providers,
      },
      json,
    );
    return ok ? 0 : 1;
  }
  const client = await configuredClient(config, path, {
    url: argument(values, "url"),
    tokenId: argument(values, "token-id"),
  });
  if (command === "status") {
    try {
      print(
        {
          protocol: await client.protocol(),
          providers: await client.providers({
            refresh: values.refresh === true,
          }),
        },
        json,
      );
      return 0;
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "HOST_UNREACHABLE",
        "Could not contact the configured driver. Check the URL, TLS trust and running service.",
      );
    }
  }
  const provider = argument(values, "provider"),
    model = argument(values, "model");
  if (!provider || !model)
    throw new DriverError(
      "MODEL_REQUIRED",
      "Select both --provider and --model for every run.",
    );
  const request = {
    provider,
    model,
    input: await inputText(argument(values, "input")),
    idempotencyKey: argument(values, "idempotency-key"),
    idleTimeoutMs: numberArgument(values, "idle-timeout-ms"),
    ...(values["max-attempts"] === undefined
      ? {}
      : { retry: { maxAttempts: numberArgument(values, "max-attempts")! } }),
  };
  let streamed = false;
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    for await (const event of client.stream(request, {
      signal: controller.signal,
    })) {
      if (json) print(event, true);
      else if (event.type === "text.delta") {
        streamed = true;
        process.stdout.write(event.text);
      }
      if (event.type === "run.completed") {
        if (!json)
          process.stdout.write((streamed ? "" : event.result.text) + "\n");
      }
      if (event.type === "run.failed" || event.type === "run.cancelled")
        throw new DriverError(
          event.error.code,
          event.error.message,
          event.error.retryable,
          event.error.outcome,
        );
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new DriverError(
        "CANCELLED",
        "The client cancelled its connection. Recover an accepted operation using its original idempotency key.",
        false,
        "uncertain",
      );
    if (error instanceof DriverError) throw error;
    throw new DriverError(
      "HOST_CONNECTION_FAILED",
      "The driver connection failed. Recover any accepted operation using its original idempotency key.",
      false,
      "uncertain",
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  return 0;
}
try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: publicError(error).toJSON() }) + "\n",
  );
  process.exitCode = 1;
}
