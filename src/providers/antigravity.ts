import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DriverError } from "../errors.js";
import { cliEnvironment, runProcess } from "./cli-process.js";
import type { CliProviderOptions } from "./local-cli.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderContext,
  ProviderTurn,
  Usage,
} from "../types.js";

const violation = () =>
  new DriverError(
    "CLI_POLICY_VIOLATION",
    "Antigravity's owned execution boundary could not be verified.",
  );
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  thinking_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
});
const nativeResult = z.object({
  status: z.literal("SUCCESS"),
  response: z.string(),
  num_turns: z.number().int(),
  usage: usageSchema,
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function executable(binary?: string) {
  if (binary && !isAbsolute(binary))
    throw new DriverError(
      "INVALID_CONFIG",
      "Use an absolute Antigravity executable path.",
    );
  for (const path of binary
    ? [binary]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((part) => join(part, "agy"))) {
    try {
      await access(path);
      return await realpath(path);
    } catch {
      /* Continue trusted host PATH discovery. */
    }
  }
  throw new DriverError(
    "CLI_UNAVAILABLE",
    "Install the qualified Antigravity CLI on this host.",
  );
}

async function isolation(options: CliProviderOptions) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new DriverError(
      "UNSUPPORTED_PLATFORM",
      "Antigravity's owned native gate requires qualified Linux x64 and Bubblewrap.",
    );
  const account =
    options.accountDirectory ?? join(homedir(), ".gemini/antigravity-cli");
  if (!isAbsolute(account))
    throw new DriverError(
      "INVALID_CONFIG",
      "Use an absolute native account directory.",
    );
  const binary = await executable(options.binary);
  try {
    await access(join(account, "jetski_state.pbtxt"));
  } catch {
    throw new DriverError(
      "CLI_AUTH_REQUIRED",
      "Sign in through the official Antigravity CLI in the selected native account directory.",
    );
  }
  const root = await mkdtemp(join(tmpdir(), "agenticdriver-antigravity-"));
  try {
    const mode = await lstat(root);
    if ((mode.mode & 0o077) !== 0 || mode.uid !== process.getuid?.())
      throw new DriverError(
        "STORAGE_UNSAFE",
        "Use a temporary filesystem that enforces private permissions.",
      );
    const home = join(root, "home"),
      config = join(home, ".gemini/config"),
      app = join(home, ".gemini/antigravity-cli"),
      workspace = join(root, "workspace"),
      control = join(root, "control"),
      audit = join(root, "audit");
    for (const path of [
      config,
      join(config, "projects"),
      app,
      workspace,
      control,
      audit,
    ])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(32).toString("hex"),
      modePath = join(control, "mode"),
      auditPath = join(audit, "events.jsonl"),
      manifest = join(control, "manifest.json"),
      helper = join(control, "hook.mjs");
    await copyFile(
      fileURLToPath(new URL("./antigravity-hook.js", import.meta.url)),
      helper,
    );
    await writeFile(join(control, "node"), "", { mode: 0o600 });
    await writeFile(join(root, "agy"), "", { mode: 0o600 });
    await writeFile(modePath, "block", { mode: 0o600 });
    await writeFile(auditPath, "", { mode: 0o600 });
    await writeFile(
      manifest,
      JSON.stringify({
        nonce,
        mode: modePath,
        audit: auditPath,
        binary: join(root, "agy"),
      }),
      { mode: 0o600 },
    );
    const hooks: Record<string, unknown> = {};
    for (const event of [
      "SessionStart",
      "PreInvocation",
      "PreToolUse",
      "PostInvocation",
    ]) {
      const handler = {
        command: [join(control, "node"), helper, event, manifest]
          .map(quote)
          .join(" "),
        timeout: 5,
      };
      hooks[event] =
        event === "PreToolUse"
          ? [{ matcher: "*", hooks: [handler] }]
          : [handler];
    }
    await writeFile(
      join(config, "hooks.json"),
      JSON.stringify({ "sdk-execution-gate": hooks }),
      { mode: 0o600 },
    );
    await writeFile(join(config, "mcp_config.json"), '{"mcpServers":{}}', {
      mode: 0o600,
    });
    await writeFile(
      join(app, "settings.json"),
      JSON.stringify({
        enableTelemetry: false,
        useG1Credits: false,
        toolPermission: "strict",
        allowNonWorkspaceAccess: false,
        permissions: {
          deny: [
            "read_file(*)",
            "write_file(*)",
            "read_url(*)",
            "execute_url(*)",
            "command(*)",
            "mcp(*)",
          ],
        },
      }),
      { mode: 0o600 },
    );
    const args = [
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--tmpfs",
      homedir(),
      "--bind",
      home,
      homedir(),
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      root,
      root,
      "--bind",
      audit,
      audit,
      "--ro-bind",
      binary,
      join(root, "agy"),
    ];
    for (const name of ["jetski_state.pbtxt", "installation_id"]) {
      const source = join(account, name);
      if (
        name === "jetski_state.pbtxt" ||
        (await access(source).then(
          () => true,
          () => false,
        ))
      ) {
        await writeFile(join(app, name), "", { mode: 0o600 });
        args.push(
          "--ro-bind",
          source,
          join(homedir(), ".gemini/antigravity-cli", name),
        );
      }
    }
    args.push(
      "--ro-bind",
      control,
      control,
      "--ro-bind",
      process.execPath,
      join(control, "node"),
      "--ro-bind",
      config,
      join(homedir(), ".gemini/config"),
      "--bind",
      join(config, "projects"),
      join(homedir(), ".gemini/config/projects"),
      "--ro-bind",
      join(app, "settings.json"),
      join(homedir(), ".gemini/antigravity-cli/settings.json"),
      "--chdir",
      workspace,
      "--",
      join(root, "agy"),
    );
    const allowed = new Set([
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
    ]);
    const env = Object.fromEntries(
      Object.entries(cliEnvironment()).filter(([key]) => allowed.has(key)),
    );
    const records = () =>
      readFileSync(auditPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line);
          if (entry.nonce !== nonce) throw violation();
          return entry;
        });
    return {
      root,
      args,
      env,
      workspace,
      modePath,
      records,
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function catalog(
  state: Awaited<ReturnType<typeof isolation>>,
  signal: AbortSignal,
) {
  const version = await runProcess("bwrap", [...state.args, "--version"], {
    env: state.env,
    signal,
  });
  if (version.trim() !== "1.5.1")
    throw new DriverError(
      "CLI_UPGRADE_REQUIRED",
      "Use qualified Antigravity CLI 1.5.1.",
    );
  const text = await runProcess("bwrap", [...state.args, "models"], {
    env: state.env,
    signal,
  });
  return text
    .split("\n")
    .map((line) => /^([a-zA-Z0-9][a-zA-Z0-9._:-]{0,199})\t/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
}

/** Native text execution with an owned deny-all hook; SDK callbacks never run inside agy. */
export function antigravity(options: CliProviderOptions = {}): ProviderAdapter {
  return {
    usageSource: "cli-report",
    info: {
      id: options.id ?? "antigravity",
      name: options.name ?? "Antigravity",
      vendor: "antigravity",
      authMode: "cli-session",
      models: options.models,
      capabilities: {
        tools: false,
        textStreaming: true,
        historyContinuation: true,
        nativeContinuation: false,
      },
      usageStatId: "antigravity",
    },
    async inspect({ signal }) {
      let state: Awaited<ReturnType<typeof isolation>> | undefined;
      try {
        state = await isolation(options);
        const models = await catalog(
          state,
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
        return {
          code: "CLI_CATALOG_AVAILABLE",
          models,
          complete: true,
          connection: {
            source: "native-runtime",
            runtime: { name: "Antigravity CLI", version: "1.5.1" },
            account: { status: "unknown" },
          },
        };
      } catch (error) {
        if (error instanceof DriverError) {
          const code = error.code;
          if (
            code === "CLI_AUTH_REQUIRED" ||
            code === "CLI_UPGRADE_REQUIRED" ||
            code === "CLI_UNAVAILABLE"
          )
            return { code };
        }
        throw error;
      } finally {
        await state?.close();
      }
    },
    async complete(request, context) {
      if (request.tools.length)
        throw new DriverError(
          "UNSUPPORTED_TOOLS",
          "Antigravity currently supports text execution only.",
        );
      const state = await isolation(options);
      try {
        const models = await catalog(
          state,
          AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        );
        if (
          !models.includes(request.model) ||
          (options.models && !options.models.includes(request.model))
        )
          throw new DriverError(
            "UNSUPPORTED_MODEL",
            "The explicitly selected Antigravity model is unavailable.",
          );
        return await executeNative(state, request.model, context, request);
      } finally {
        await state.close();
      }
    },
  };
}

async function executeNative(
  state: Awaited<ReturnType<typeof isolation>>,
  model: string,
  context: Pick<ProviderContext, "signal" | "emitText" | "reportProgress">,
  application?: ProviderRequest,
): Promise<ProviderTurn> {
  let phase: "init" | "control" | "application" | "done" = "init",
    write!: (data: string) => void,
    end!: () => void,
    turn: ProviderTurn | undefined;
  const controller = new AbortController();
  const startup = setTimeout(
    () =>
      controller.abort(
        new DriverError(
          "CLI_GATE_UNAVAILABLE",
          "Antigravity's owned startup gate was not confirmed.",
        ),
      ),
    20_000,
  );
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const send = (content: string) =>
    write(JSON.stringify({ event: "user", message: { content } }) + "\n");
  try {
    await runProcess(
      "bwrap",
      [
        ...state.args,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--disable-slash-commands",
        "--print-timeout",
        "0",
      ],
      {
        env: state.env,
        signal,
        retainOutput: false,
        onStart(sendLine, close) {
          write = sendLine;
          end = close;
        },
        onLine(line) {
          const event = JSON.parse(line);
          if (event.event === "init") {
            if (
              phase !== "init" ||
              event.init?.model !== model ||
              event.init?.permission_mode !== "strict" ||
              event.init?.cwd !== state.workspace
            )
              throw violation();
            phase = "control";
            send("SDK execution-gate startup check. Do not invoke a model.");
          } else if (event.event === "step_update") {
            const step = event.step_update;
            if (
              step.step_type === "tool" ||
              step.subagent_info ||
              step.tool_info
            )
              throw violation();
            if (
              !["user_input", "agent_response", "checkpoint"].includes(
                step.step_type,
              )
            )
              throw violation();
            if (
              phase === "application" &&
              step.step_type === "agent_response" &&
              typeof step.text_delta === "string"
            ) {
              context.emitText(step.text_delta);
              context.reportProgress();
            }
          } else if (event.event === "result") {
            const parsed = nativeResult.safeParse(event.result);
            if (!parsed.success) throw violation();
            const result = parsed.data,
              records = state.records();
            if (phase === "control") {
              if (
                result.num_turns !== 1 ||
                result.response ||
                Object.values(result.usage).some((value) => value !== 0) ||
                !records.some(
                  (record) =>
                    record.event === "SessionStart" &&
                    record.version === "1.5.1",
                ) ||
                !records.some(
                  (record) =>
                    record.event === "PreInvocation" &&
                    record.phase === "block",
                )
              )
                throw violation();
              clearTimeout(startup);
              if (!application) {
                phase = "done";
                end();
                turn = {
                  text: "",
                  usage: { inputTokens: 0, outputTokens: 0 },
                  finishReason: "stop",
                };
              } else {
                writeFileSync(state.modePath, "run");
                phase = "application";
                send(
                  JSON.stringify({
                    instructions: application.instructions,
                    messages: application.messages,
                  }),
                );
              }
            } else if (phase === "application") {
              if (
                result.num_turns !== 2 ||
                !result.response ||
                records.some((record) => record.event === "PreToolUse") ||
                records.filter(
                  (record) =>
                    record.event === "PreInvocation" && record.phase === "run",
                ).length !== 1 ||
                !records.some((record) => record.event === "PostInvocation")
              )
                throw violation();
              const usage: Usage = {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
                ...(result.usage.thinking_tokens !== undefined
                  ? { reasoningTokens: result.usage.thinking_tokens }
                  : {}),
                ...(result.usage.cache_read_tokens !== undefined
                  ? { cachedInputTokens: result.usage.cache_read_tokens }
                  : {}),
              };
              turn = {
                text: result.response,
                usage,
                finishReason: "stop",
              };
              phase = "done";
              end();
            } else throw violation();
          } else throw violation();
        },
      },
    );
    if (!turn) throw violation();
    return turn;
  } finally {
    clearTimeout(startup);
  }
}

/** Runs the production startup proof and closes before any application inference. */
export async function checkAntigravityGate(
  options: CliProviderOptions & { model: string; signal: AbortSignal },
) {
  const state = await isolation(options);
  try {
    const models = await catalog(
      state,
      AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
    );
    if (!models.includes(options.model))
      throw new DriverError(
        "UNSUPPORTED_MODEL",
        "The explicitly selected Antigravity model is unavailable.",
      );
    await executeNative(state, options.model, {
      signal: options.signal,
      emitText() {},
      reportProgress() {},
    });
    return {
      status: "ready-for-live-check" as const,
      version: "1.5.1",
      nativeToolPolicy: "deny-all" as const,
      applicationPromptSubmitted: false as const,
      modelInvocations: 0 as const,
      liveCertified: false as const,
    };
  } finally {
    await state.close();
  }
}
