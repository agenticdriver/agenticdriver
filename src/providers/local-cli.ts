import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { DriverError } from "../errors.js";
import type {
  ProviderAdapter,
  ProviderContext,
  ProviderTurn,
  Usage,
} from "../types.js";

export interface CliProviderOptions {
  id?: string;
  name?: string;
  /** Trusted host configuration. Never accepted in a remote run request. */
  binary?: string;
  accountDirectory?: string;
  models?: string[];
}
type Vendor = "codex" | "claude-code" | "gemini-cli";

export function codex(options: CliProviderOptions = {}) {
  return localCli("codex", options);
}
export function claudeCode(options: CliProviderOptions = {}) {
  return localCli("claude-code", options);
}
export function geminiCli(options: CliProviderOptions = {}) {
  return localCli("gemini-cli", options);
}

function localCli(
  vendor: Vendor,
  options: CliProviderOptions,
): ProviderAdapter {
  if (options.accountDirectory && !isAbsolute(options.accountDirectory))
    throw new Error("The CLI account directory must be absolute.");
  const binary =
    options.binary ??
    { codex: "codex", "claude-code": "claude", "gemini-cli": "gemini" }[vendor];
  const env = cliEnvironment();
  if (options.accountDirectory)
    env[
      {
        codex: "CODEX_HOME",
        "claude-code": "CLAUDE_CONFIG_DIR",
        "gemini-cli": "GEMINI_CLI_HOME",
      }[vendor]
    ] = options.accountDirectory;
  let checked: Promise<void> | undefined;
  const checkFeatures = async (signal: AbortSignal, cwd?: string) => {
    const help = await runProcess(
      binary,
      vendor === "codex" ? ["exec", "--help"] : ["--help"],
      { env, cwd, signal, includeStderr: true },
    );
    const required =
      vendor === "codex"
        ? ["--ignore-user-config", "--ephemeral", "--sandbox", "--json"]
        : vendor === "claude-code"
          ? ["--restricted", "--safe-mode", "--strict-mcp-config", "--tools"]
          : ["--admin-policy", "--output-format", "--extensions"];
    if (!required.every((flag) => help.includes(flag)))
      throw new DriverError(
        "CLI_UPGRADE_REQUIRED",
        "Upgrade the CLI to a version with the required restricted execution features.",
      );
  };
  const preflight = () =>
    (checked ??= checkFeatures(AbortSignal.timeout(10_000)).catch((error) => {
      checked = undefined;
      throw error;
    }));
  return {
    info: {
      id: options.id ?? vendor,
      name:
        options.name ??
        {
          codex: "Codex CLI",
          "claude-code": "Claude Code",
          "gemini-cli": "Gemini CLI",
        }[vendor],
      vendor,
      authMode: "cli-session",
      capabilities: { tools: false, textStreaming: vendor !== "codex" },
      models: options.models,
      usageStatId: {
        codex: "codex",
        "claude-code": "claude",
        "gemini-cli": "gemini",
      }[vendor],
    },
    async inspect({ signal }) {
      const cwd = await mkdtemp(join(tmpdir(), "agenticdriver-inspect-"));
      try {
        await checkFeatures(signal, cwd);
        if (vendor === "gemini-cli") return { code: "CLI_STATUS_UNKNOWN" };
        let exitCode: number | null = null;
        // Output can contain account identifiers or masked keys. Retain nothing in the result.
        await runProcess(
          binary,
          vendor === "codex" ? ["login", "status"] : ["auth", "status"],
          {
            env,
            cwd,
            signal,
            acceptedExitCodes: [0, 1],
            onExit: (code) => {
              exitCode = code;
            },
          },
        );
        return {
          code: exitCode === 0 ? "CLI_SESSION_PRESENT" : "CLI_AUTH_REQUIRED",
        };
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof DriverError &&
          (error.code === "CLI_UNAVAILABLE" ||
            error.code === "CLI_UPGRADE_REQUIRED")
        )
          return { code: error.code };
        return { code: "CLI_STATUS_UNKNOWN" };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async complete(request, context) {
      if (request.tools.length)
        throw new DriverError(
          "UNSUPPORTED_TOOLS",
          "CLI text adapters do not expose application tools.",
        );
      context.signal.throwIfAborted();
      await preflight();
      context.signal.throwIfAborted();
      const cwd = await mkdtemp(join(tmpdir(), "agenticdriver-"));
      try {
        const operation = await cliOperation(vendor, request.model, cwd);
        context.signal.throwIfAborted();
        const prompt = [
          request.instructions ?? "",
          ...request.messages.map(
            (message) => `${message.role}: ${message.content}`,
          ),
        ].join("\n\n");
        const stream = createCliStream(vendor, context);
        const output = await runProcess(binary, operation.args, {
          cwd,
          env: { ...env, ...operation.env },
          signal: context.signal,
          input: prompt,
          onLine: stream.accept,
        });
        return stream.finish(output);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

async function cliOperation(vendor: Vendor, model: string, cwd: string) {
  if (vendor === "codex")
    return {
      args: [
        "exec",
        "--json",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        "--config",
        'approval_policy="never"',
        "--config",
        "features.shell_tool=false",
        "--config",
        "features.unified_exec=false",
        "--config",
        "features.hooks=false",
        "--config",
        "features.apps=false",
        "--config",
        "features.multi_agent=false",
        "--config",
        'web_search="disabled"',
        "--config",
        "mcp_servers={}",
        "--config",
        "project_doc_max_bytes=0",
        "-",
      ],
      env: {},
    };
  if (vendor === "claude-code")
    return {
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--restricted",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--model",
        model,
      ],
      env: {},
    };
  const settings = join(cwd, "settings.json"),
    policy = join(cwd, "deny-tools.toml");
  await writeFile(
    settings,
    JSON.stringify({
      tools: {
        core: ["__agenticdriver_no_tools__"],
        discoveryCommand: "",
        callCommand: "",
      },
      hooksConfig: { enabled: false },
      mcp: { allowed: [], serverCommand: "" },
      admin: {
        extensions: { enabled: false },
        mcp: { enabled: false },
        skills: { enabled: false },
      },
      context: {
        fileName: ".agenticdriver-no-context",
        includeDirectories: [],
        includeDirectoryTree: false,
        loadMemoryFromIncludeDirectories: false,
        memoryBoundaryMarkers: [],
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    policy,
    '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
    { mode: 0o600 },
  );
  return {
    args: [
      "--prompt",
      "Answer the request provided on stdin using text only.",
      "--output-format",
      "stream-json",
      "--extensions",
      "none",
      "--admin-policy",
      policy,
      "--approval-mode",
      "default",
      "--model",
      model,
    ],
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings },
  };
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GEMINI_CLI_HOME",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_CA_CERTIFICATE",
  ];
  return Object.fromEntries(
    keys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

/** No shell interpolation; bound output and terminate the process group on cancellation. */
export function runProcess(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    input?: string;
    includeStderr?: boolean;
    onLine?: (line: string) => void;
    acceptedExitCodes?: number[];
    onExit?: (code: number | null) => void;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    const acceptText = (text: string, end = false) => {
      if (!options.onLine || failure) return;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = end ? "" : lines.pop()!;
      for (const line of lines) if (line.trim()) options.onLine(line);
    };
    let bytes = 0,
      failure: unknown,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      terminate("SIGTERM");
      killTimer ??= setTimeout(() => terminate("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => {
      failure =
        options.signal.reason instanceof DriverError
          ? options.signal.reason
          : new DriverError(
              options.signal.reason?.name === "TimeoutError"
                ? "TIMEOUT"
                : "CANCELLED",
              "The CLI operation was interrupted.",
            );
      stop();
    };
    const receive = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        failure = new DriverError(
          "CLI_OUTPUT_LIMIT",
          "The CLI exceeded its output limit.",
        );
        stop();
      } else if (retain) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      receive(chunk, true);
      try {
        acceptText(decoder.write(chunk));
      } catch (error) {
        failure = error;
        stop();
      }
    });
    child.stderr.on("data", (chunk) =>
      receive(chunk as Buffer, options.includeStderr ?? false),
    );
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failure = new DriverError(
        "CLI_UNAVAILABLE",
        "The CLI executable could not be started.",
      );
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("close", (code) => {
      options.onExit?.(code);
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      terminate("SIGKILL");
      try {
        acceptText(decoder.end(), true);
      } catch (error) {
        failure = error;
      }
      if (failure) reject(failure);
      else if (
        code === null ||
        !(options.acceptedExitCodes ?? [0]).includes(code)
      )
        reject(
          new DriverError(
            "CLI_FAILED",
            "The CLI failed. Check its installed version, sign-in, and model access.",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(options.input ?? "");
  });
}

/** CLI JSONL progress is parsed as it arrives. Stderr and startup notices never refresh idle timeouts. */
export function createCliStream(vendor: Vendor, context: ProviderContext) {
  let finalResult: Record<string, unknown> | undefined,
    text = "",
    partialMessage = false;
  const snapshots = new Map<string, string>();
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DriverError(
        "INVALID_CLI_OUTPUT",
        "The CLI returned an invalid stream event.",
      );
    return value as Record<string, unknown>;
  };
  const policyViolation = () => {
    throw new DriverError(
      "CLI_POLICY_VIOLATION",
      "The CLI reported an operation outside its text-only policy.",
    );
  };
  const inspectBlock = (block: Record<string, unknown>) => {
    if (["tool_use", "server_tool_use"].includes(String(block.type)))
      policyViolation();
  };
  return {
    accept(line: string) {
      let event: Record<string, unknown>;
      try {
        event = object(JSON.parse(line));
      } catch {
        throw new DriverError(
          "INVALID_CLI_OUTPUT",
          "The CLI returned invalid JSON.",
        );
      }
      if (["error", "turn.failed"].includes(String(event.type)))
        throw new DriverError(
          "CLI_FAILED",
          "The CLI failed to complete the request.",
        );
      if (vendor === "codex") {
        if (event.item) {
          const item = object(event.item);
          if (
            [
              "command_execution",
              "file_change",
              "mcp_tool_call",
              "web_search",
              "collab_tool_call",
            ].includes(String(item.type))
          )
            policyViolation();
          if (item.type === "agent_message" && typeof item.text === "string") {
            const key = String(item.id ?? "message"),
              previous = snapshots.get(key) ?? "";
            if (!item.text.startsWith(previous))
              throw new DriverError(
                "INVALID_CLI_OUTPUT",
                "The CLI rewrote already streamed text.",
              );
            context.emitText(item.text.slice(previous.length));
            snapshots.set(key, item.text);
          } else if (
            item.type === "reasoning" &&
            typeof item.text === "string" &&
            item.text
          ) {
            const key = String(item.id ?? "reasoning"),
              previous = snapshots.get(key);
            if (previous !== item.text) {
              context.reportProgress();
              snapshots.set(key, item.text);
            }
          }
        }
      } else if (vendor === "claude-code") {
        if (event.type === "stream_event") {
          const part = object(event.event);
          if (part.type === "message_start") partialMessage = false;
          if (part.type === "content_block_start") {
            inspectBlock(object(part.content_block));
            context.reportProgress();
          }
          if (part.type === "content_block_delta") {
            const delta = object(part.delta);
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              partialMessage = true;
              context.emitText(delta.text);
            } else if (
              (typeof delta.thinking === "string" && delta.thinking) ||
              (typeof delta.signature === "string" && delta.signature)
            )
              context.reportProgress();
          }
        }
        if (event.type === "assistant") {
          const message = object(event.message);
          if (Array.isArray(message.content))
            for (const value of message.content) {
              const block = object(value);
              inspectBlock(block);
              if (
                !partialMessage &&
                block.type === "text" &&
                typeof block.text === "string"
              )
                context.emitText(block.text);
            }
        }
        if (event.type === "result") finalResult = event;
      } else {
        if (["tool_use", "tool_result"].includes(String(event.type)))
          policyViolation();
        if (
          event.type === "message" &&
          event.role === "assistant" &&
          typeof event.content === "string"
        ) {
          text += event.content;
          context.emitText(event.content);
        }
        if (event.type === "result") finalResult = event;
      }
    },
    finish(output: string): ProviderTurn {
      if (vendor === "codex") return normalizeCli(vendor, output);
      if (!finalResult)
        throw new DriverError(
          "INCOMPLETE_STREAM",
          "The CLI exited without a completed result.",
        );
      if (vendor === "claude-code")
        return normalizeCli(vendor, JSON.stringify(finalResult));
      if (finalResult.status !== "success" || finalResult.error)
        throw new DriverError(
          "CLI_FAILED",
          "Gemini CLI failed to complete the request.",
        );
      const stats = finalResult.stats ? object(finalResult.stats) : {};
      if (typeof stats.tool_calls === "number" && stats.tool_calls > 0)
        policyViolation();
      const count = (key: string) =>
        typeof stats[key] === "number" &&
        Number.isFinite(stats[key]) &&
        stats[key] >= 0
          ? (stats[key] as number)
          : undefined;
      return {
        text,
        usage: {
          inputTokens: count("input_tokens"),
          outputTokens: count("output_tokens"),
          cachedInputTokens: count("cached"),
        },
      };
    },
  };
}

export function normalizeCli(vendor: Vendor, output: string): ProviderTurn {
  try {
    if (vendor === "codex") {
      let text = "",
        complete = false,
        usage: Usage | undefined;
      for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
        const event = z
          .object({
            type: z.string(),
            item: z
              .object({ type: z.string(), text: z.string().optional() })
              .optional(),
            usage: z
              .object({
                input_tokens: z.number().optional(),
                output_tokens: z.number().optional(),
                cached_input_tokens: z.number().optional(),
              })
              .optional(),
          })
          .parse(JSON.parse(line));
        if (["error", "turn.failed"].includes(event.type))
          throw new DriverError(
            "CLI_FAILED",
            "Codex failed to complete the request.",
          );
        if (
          event.item &&
          [
            "command_execution",
            "file_change",
            "mcp_tool_call",
            "web_search",
          ].includes(event.item.type)
        )
          throw new DriverError(
            "CLI_POLICY_VIOLATION",
            "The CLI reported an operation outside its text-only policy.",
          );
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          text += event.item.text ?? "";
        if (event.type === "turn.completed") {
          complete = true;
          if (event.usage)
            usage = {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
            };
        }
      }
      if (!complete)
        throw new DriverError(
          "INCOMPLETE_STREAM",
          "Codex exited without a completed turn.",
        );
      return { text, usage };
    }
    if (vendor === "claude-code") {
      const result = z
        .object({
          type: z.literal("result"),
          is_error: z.boolean(),
          result: z.string().optional(),
          total_cost_usd: z.number().optional(),
          usage: z
            .object({
              input_tokens: z.number().optional(),
              output_tokens: z.number().optional(),
              cache_read_input_tokens: z.number().optional(),
              cache_creation_input_tokens: z.number().optional(),
            })
            .optional(),
        })
        .parse(JSON.parse(output));
      if (result.is_error || result.result === undefined)
        throw new DriverError(
          "CLI_FAILED",
          "Claude Code failed to complete the request.",
        );
      const u = result.usage;
      return {
        text: result.result,
        usage: {
          inputTokens:
            u?.input_tokens === undefined
              ? undefined
              : u.input_tokens +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0),
          outputTokens: u?.output_tokens,
          cachedInputTokens: u?.cache_read_input_tokens,
          costUsd: result.total_cost_usd,
        },
      };
    }
    const result = z
      .object({
        response: z.string().optional(),
        error: z.unknown().optional(),
        stats: z
          .object({
            models: z
              .record(
                z.string(),
                z.object({
                  tokens: z
                    .object({
                      prompt: z.number().optional(),
                      candidates: z.number().optional(),
                      cached: z.number().optional(),
                      thoughts: z.number().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      })
      .parse(JSON.parse(output));
    if (result.error || result.response === undefined)
      throw new DriverError(
        "CLI_FAILED",
        "Gemini CLI failed to complete the request.",
      );
    const modelUsage = Object.values(result.stats?.models ?? {})
      .map((m) => m.tokens)
      .filter((t) => t !== undefined);
    const sum = (field: "prompt" | "candidates" | "cached" | "thoughts") =>
      modelUsage.length && modelUsage.every((u) => u[field] !== undefined)
        ? modelUsage.reduce((n, u) => n + u[field]!, 0)
        : undefined;
    const candidates = sum("candidates"),
      thoughts = sum("thoughts");
    return {
      text: result.response,
      usage: {
        inputTokens: sum("prompt"),
        outputTokens:
          candidates === undefined ? undefined : candidates + (thoughts ?? 0),
        cachedInputTokens: sum("cached"),
        reasoningTokens: thoughts,
      },
    };
  } catch (error) {
    if (error instanceof DriverError) throw error;
    throw new DriverError(
      "INVALID_CLI_OUTPUT",
      "The CLI did not return its expected JSON format.",
    );
  }
}
