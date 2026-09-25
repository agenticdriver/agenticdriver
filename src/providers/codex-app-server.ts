import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DriverError } from "../errors.js";
import type { ProviderAdapter, ProviderTurn, Usage } from "../types.js";
import type { CodexProviderOptions } from "./local-cli.js";
import { cliEnvironment, runProcess } from "./cli-process.js";
import { codexCliFailure } from "./codex-cli-errors.js";

// Pin the protocol whose environment and tool restrictions the native fixture audits.
const supportedVersion = "codex-cli 0.157.0";
const restrictions = [
  'model_provider="openai"',
  'approval_policy="never"',
  "agents.enabled=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.hooks=false",
  "features.plugins=false",
  "features.apps=false",
  "features.goals=false",
  "features.view_image=false",
  "features.sleep_tool=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
  "features.remote_control=false",
  "features.memories=false",
  "features.memory_tool=false",
  "features.skip_host_skill_discovery=true",
  "tools.update_plan.enabled=false",
  "tools.experimental_request_user_input.enabled=false",
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  'developer_instructions=""',
];

const object = z.record(z.string(), z.unknown());
const failure = (value: unknown) =>
  codexCliFailure(value) ??
  new DriverError("CLI_FAILED", "Codex failed to complete the request.");
const invalid = () =>
  new DriverError(
    "INVALID_CLI_OUTPUT",
    "Codex returned an invalid protocol message.",
  );
const policy = () =>
  new DriverError(
    "CLI_POLICY_VIOLATION",
    "Codex requested an operation outside its application context policy.",
  );
const counts = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
});

/** Native sign-in stays entirely inside Codex. No credential file is read by the SDK. */
export function codexAppServer(options: CodexProviderOptions): ProviderAdapter {
  if (options.accountDirectory && !isAbsolute(options.accountDirectory))
    throw new Error("The CLI account directory must be absolute.");
  const binary = options.binary ?? "codex";
  const env = cliEnvironment();
  if (options.accountDirectory) env.CODEX_HOME = options.accountDirectory;
  const check = async (signal: AbortSignal, cwd?: string) => {
    const version = await runProcess(binary, ["--version"], {
      env,
      cwd,
      signal,
    });
    if (version.trim() !== supportedVersion)
      throw new DriverError(
        "CLI_UPGRADE_REQUIRED",
        "This adapter requires the qualified Codex CLI 0.157.0 app-server protocol. Other versions must pass native isolation checks before use.",
      );
  };
  let checked: Promise<void> | undefined;
  return {
    usageSource: "cli-report",
    info: {
      id: options.id ?? "codex",
      name: options.name ?? "Codex CLI",
      vendor: "codex",
      authMode: "cli-session",
      capabilities: {
        tools: false,
        textStreaming: false,
        historyContinuation: true,
        nativeContinuation: false,
      },
      models: options.models,
      usageStatId: "codex",
    },
    async inspect({ signal }) {
      const cwd = await mkdtemp(join(tmpdir(), "agenticdriver-inspect-"));
      try {
        await check(signal, cwd);
        let code: number | null = null;
        await runProcess(binary, ["login", "status"], {
          env,
          cwd,
          signal,
          acceptedExitCodes: [0, 1],
          onExit: (value) => {
            code = value;
          },
        });
        return {
          code: code === 0 ? "CLI_SESSION_PRESENT" : "CLI_AUTH_REQUIRED",
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
          "The Codex text adapter does not expose application tools.",
        );
      context.signal.throwIfAborted();
      await (checked ??= check(AbortSignal.timeout(10_000)).catch((error) => {
        checked = undefined;
        throw error;
      }));
      context.signal.throwIfAborted();
      const cwd = await mkdtemp(join(tmpdir(), "agenticdriver-"));
      let result: ProviderTurn | undefined;
      let usage: Usage | undefined;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let phase = 0;
      let text = "";
      const completedItems = new Set<string>();
      let send: (value: unknown) => void;
      let end: () => void;
      const rpc = (id: number, method: string, params: unknown) =>
        send({ id, method, params });
      const prompt = [
        request.instructions ?? "",
        ...request.messages.map(
          (message) => `${message.role}: ${message.content}`,
        ),
      ].join("\n\n");
      let bootstrapRetry = false;
      try {
        for (;;) {
          try {
            await runProcess(
              binary,
              [
                "app-server",
                "--stdio",
                "--strict-config",
                ...restrictions.flatMap((value) => ["--config", value]),
              ],
              {
                cwd,
                env,
                signal: context.signal,
                retainOutput: false,
                classifyExit: (_code, stderr) => {
                  const diagnostic =
                    stderr
                      .trim()
                      .split(/\r?\n/)
                      .at(-1)
                      ?.replace(/^Error: /, "") ?? "";
                  if (
                    diagnostic === "application network permission was revoked"
                  )
                    return new DriverError(
                      "CLI_POLICY_CHANGED",
                      "Codex revoked its application network permission. Its current account policy must allow the operation before retrying.",
                    );
                  return codexCliFailure(diagnostic);
                },
                onStart(write, close) {
                  send = (value) => write(JSON.stringify(value) + "\n");
                  end = close;
                  rpc(1, "initialize", {
                    clientInfo: { name: "agenticdriver", version: "0.1.0" },
                    capabilities: { experimentalApi: true },
                  });
                },
                onLine(line) {
                  let message: Record<string, unknown>;
                  try {
                    message = object.parse(JSON.parse(line));
                  } catch {
                    throw invalid();
                  }
                  // This adapter never grants requests for tools, approvals, questions or credentials.
                  if (
                    typeof message.method === "string" &&
                    message.id !== undefined
                  ) {
                    send({
                      id: message.id,
                      error: {
                        code: -32601,
                        message: "This client does not support that operation.",
                      },
                    });
                    throw policy();
                  }
                  if (message.id !== undefined) {
                    if (message.id !== phase + 1) throw invalid();
                    if (message.error !== undefined)
                      throw failure(message.error);
                    const value = object.parse(message.result);
                    phase++;
                    if (phase === 1) {
                      send({ method: "initialized" });
                      rpc(2, "config/read", { includeLayers: false });
                    } else if (phase === 2) {
                      const config = object.parse(value.config);
                      const servers =
                        config.mcp_servers === undefined
                          ? {}
                          : object.parse(config.mcp_servers);
                      // An empty table does not remove inherited servers. Disable each exact name.
                      if (
                        Object.keys(servers).some(
                          (name) => !/^[A-Za-z0-9_-]+$/.test(name),
                        )
                      )
                        throw new DriverError(
                          "CLI_POLICY_VIOLATION",
                          "The account has an MCP server name this adapter cannot safely disable.",
                        );
                      const overrides = Object.fromEntries(
                        Object.keys(servers).map((name) => [
                          `mcp_servers.${name}.enabled`,
                          false,
                        ]),
                      );
                      rpc(3, "thread/start", {
                        model: request.model,
                        allowProviderModelFallback: false,
                        cwd,
                        approvalPolicy: "never",
                        sandbox: "read-only",
                        ephemeral: true,
                        environments: [],
                        selectedCapabilityRoots: [],
                        dynamicTools: [],
                        config: overrides,
                      });
                    } else if (phase === 3) {
                      threadId = z
                        .string()
                        .min(1)
                        .parse(object.parse(value.thread).id);
                      rpc(4, "turn/start", {
                        threadId,
                        model: request.model,
                        ...(options.reasoningEffort
                          ? { effort: options.reasoningEffort }
                          : {}),
                        environments: [],
                        input: [{ type: "text", text: prompt }],
                      });
                    } else if (phase === 4) {
                      turnId = z
                        .string()
                        .min(1)
                        .parse(object.parse(value.turn).id);
                    } else throw invalid();
                    return;
                  }
                  if (typeof message.method !== "string") throw invalid();
                  const params = object.parse(message.params ?? {});
                  if (
                    threadId &&
                    params.threadId !== undefined &&
                    params.threadId !== threadId
                  )
                    throw invalid();
                  if (
                    turnId &&
                    params.turnId !== undefined &&
                    params.turnId !== turnId
                  )
                    throw invalid();
                  if (message.method === "thread/tokenUsage/updated") {
                    if (phase !== 4) throw invalid();
                    const reported = counts.parse(
                      object.parse(params.tokenUsage).total,
                    );
                    usage = {
                      inputTokens: reported.inputTokens,
                      outputTokens: reported.outputTokens,
                      cachedInputTokens: reported.cachedInputTokens,
                      ...(reported.reasoningOutputTokens === undefined
                        ? {}
                        : { reasoningTokens: reported.reasoningOutputTokens }),
                    };
                  } else if (message.method === "error") {
                    if (params.willRetry !== true) throw failure(params.error);
                  } else if (
                    ["item/started", "item/completed"].includes(message.method)
                  ) {
                    const item = object.parse(params.item);
                    const type = z.string().parse(item.type);
                    if (
                      !["userMessage", "agentMessage", "reasoning"].includes(
                        type,
                      )
                    )
                      throw policy();
                    if (
                      message.method === "item/completed" &&
                      type === "agentMessage"
                    ) {
                      if (phase !== 4) throw invalid();
                      if (
                        item.questions !== undefined &&
                        item.questions !== null &&
                        (!Array.isArray(item.questions) ||
                          item.questions.length)
                      )
                        throw policy();
                      const id = z.string().parse(item.id);
                      if (!completedItems.has(id)) {
                        const part = z.string().parse(item.text);
                        completedItems.add(id);
                        text += part;
                        context.emitText(part);
                      }
                    }
                  } else if (message.method === "turn/completed") {
                    const turn = object.parse(params.turn);
                    if (phase !== 4 || turn.id !== turnId) throw invalid();
                    if (turn.status !== "completed") {
                      if (turn.status === "interrupted")
                        throw new DriverError(
                          "CANCELLED",
                          "Codex was interrupted.",
                        );
                      throw failure(turn.error);
                    }
                    if (result) throw invalid();
                    result = { text, ...(usage ? { usage } : {}) };
                    end();
                  } else if (
                    (message.method.startsWith("item/agentMessage/") ||
                      message.method.startsWith("item/reasoning/")) &&
                    typeof params.delta === "string" &&
                    params.delta.length
                  ) {
                    context.reportProgress();
                  }
                },
              },
            );
            break;
          } catch (error) {
            // A native token refresh can invalidate its startup policy generation.
            // Re-open the native protocol once, under freshly loaded native policy,
            // only before initialize replies and before any thread/prompt is sent.
            if (
              !bootstrapRetry &&
              phase === 0 &&
              error instanceof DriverError &&
              error.code === "CLI_POLICY_CHANGED"
            ) {
              bootstrapRetry = true;
              context.signal.throwIfAborted();
              continue;
            }
            throw error;
          }
        }
        if (!result)
          throw new DriverError(
            "INCOMPLETE_STREAM",
            "Codex exited without a completed turn.",
          );
        return result;
      } catch (error) {
        if (error instanceof z.ZodError) throw invalid();
        throw error;
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
