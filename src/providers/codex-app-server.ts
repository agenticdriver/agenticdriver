import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DriverError } from "../errors.js";
import type { ProviderAdapter, ProviderTurn, Usage } from "../types.js";
import type { CodexProviderOptions } from "./local-cli.js";
import { cliEnvironment, runProcess } from "./cli-process.js";
import { codexCliFailure } from "./codex-cli-errors.js";
import { codexMcpBridge } from "./codex-mcp-bridge.js";
import { codexHistory } from "./codex-history.js";

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

/** Read native catalog metadata in a separate process; never start a thread or turn. */
async function inspectModels(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
) {
  const pageSchema = z.object({
    data: z
      .array(
        z.object({
          model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/),
        }),
      )
      .max(1000),
    nextCursor: z.string().min(1).max(4096).nullable(),
  });
  const models = new Set<string>();
  const cursors = new Set<string>();
  let requestId = 1,
    pages = 0;
  let result: { models: string[]; complete: boolean } | undefined;
  let send: (message: unknown) => void, end: () => void;
  const page = (cursor?: string) =>
    send({
      id: ++requestId,
      method: "model/list",
      params: {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      },
    });
  await runProcess(
    binary,
    [
      "app-server",
      "--stdio",
      "--strict-config",
      ...restrictions.flatMap((value) => ["--config", value]),
    ],
    {
      env,
      cwd,
      signal,
      retainOutput: false,
      onStart(write, close) {
        send = (value) => write(JSON.stringify(value) + "\n");
        end = close;
        send({
          id: requestId,
          method: "initialize",
          params: {
            clientInfo: { name: "agenticdriver_catalog", version: "0.1.0" },
          },
        });
      },
      onLine(line) {
        const message = object.parse(JSON.parse(line));
        if (message.method !== undefined) {
          // Initialization may send status notices; it cannot request any authority.
          if (typeof message.method !== "string" || message.id !== undefined)
            throw policy();
          if (message.method === "error")
            throw failure(object.parse(message.params).error);
          return;
        }
        if (result || message.id !== requestId) throw invalid();
        if (message.error !== undefined) throw failure(message.error);
        if (requestId === 1) {
          object.parse(message.result);
          send({ method: "initialized" });
          page();
          return;
        }
        const current = pageSchema.parse(message.result);
        pages++;
        for (const item of current.data) models.add(item.model);
        if (current.nextCursor && cursors.has(current.nextCursor))
          throw invalid();
        if (!current.nextCursor || models.size >= 1000 || pages >= 20) {
          result = {
            models: [...models].slice(0, 1000),
            complete: !current.nextCursor && models.size <= 1000,
          };
          end();
        } else {
          cursors.add(current.nextCursor);
          page(current.nextCursor);
        }
      },
    },
  );
  if (!result) throw invalid();
  return result;
}

/** Native sign-in stays entirely inside Codex. No credential file is read by the SDK. */
export function codexAppServer(options: CodexProviderOptions): ProviderAdapter {
  if (options.accountDirectory && !isAbsolute(options.accountDirectory))
    throw new Error("The CLI account directory must be absolute.");
  const binary = options.binary ?? "codex";
  const toolsEnabled = options.applicationTools === "mcp";
  if (toolsEnabled && (process.platform !== "linux" || process.arch !== "x64"))
    throw new DriverError(
      "UNSUPPORTED_TOOLS",
      "Native MCP application tools currently require qualified Linux x64 Codex.",
    );
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
        tools: toolsEnabled,
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
        if (code !== 0) return { code: "CLI_AUTH_REQUIRED" };
        try {
          const catalog = await inspectModels(binary, env, cwd, signal);
          return { code: "CLI_CATALOG_AVAILABLE", ...catalog };
        } catch {
          signal.throwIfAborted();
          // A saved login still does not prove fresh account access. Keep configured
          // aliases distinct from an inventory when the native catalog is unavailable.
          return { code: "CLI_SESSION_PRESENT" };
        }
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
      if (request.tools.length && !toolsEnabled)
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
      const protocol = new AbortController();
      const signal = AbortSignal.any([context.signal, protocol.signal]);
      let bridge: Awaited<ReturnType<typeof codexMcpBridge>> | undefined;
      let interruptAcknowledged = false;
      let historyPending = false;
      const rpc = (id: number, method: string, params: unknown) =>
        send({ id, method, params });
      const prompt = [
        request.instructions ?? "",
        ...request.messages.map(
          (message) => `${message.role}: ${message.content}`,
        ),
      ].join("\n\n");
      const startTurn = () =>
        rpc(4, "turn/start", {
          threadId,
          model: request.model,
          ...(options.reasoningEffort
            ? { effort: options.reasoningEffort }
            : {}),
          environments: [],
          input: [
            {
              type: "text",
              text: toolsEnabled
                ? codexHistory(request, bridge?.name).input
                : prompt,
            },
          ],
        });
      let bootstrapRetry = false;
      try {
        if (request.tools.length)
          bridge = await codexMcpBridge({
            directory: cwd,
            tools: request.tools,
            fail: (error) => protocol.abort(error),
            interrupt() {
              if (!threadId || !turnId || phase !== 4) throw invalid();
              rpc(5, "turn/interrupt", { threadId, turnId });
            },
          });
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
                signal,
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
                    if (message.id === 6 && phase === 3 && historyPending) {
                      if (message.error !== undefined)
                        throw failure(message.error);
                      object.parse(message.result);
                      historyPending = false;
                      startTurn();
                      return;
                    }
                    if (message.id === 5 && bridge?.interrupted) {
                      if (interruptAcknowledged) throw invalid();
                      interruptAcknowledged = true;
                      if (message.error !== undefined)
                        throw failure(message.error);
                      object.parse(message.result);
                      return;
                    }
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
                      const overrides: Record<string, unknown> =
                        Object.fromEntries(
                          Object.keys(servers).map((name) => [
                            `mcp_servers.${name}.enabled`,
                            false,
                          ]),
                        );
                      if (bridge) {
                        if (Object.hasOwn(servers, bridge.name)) throw policy();
                        overrides[`mcp_servers.${bridge.name}`] = bridge.config;
                      }
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
                      const history = toolsEnabled
                        ? codexHistory(request, bridge?.name).items
                        : [];
                      if (history.length) {
                        historyPending = true;
                        rpc(6, "thread/inject_items", {
                          threadId,
                          items: history,
                        });
                      } else startTurn();
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
                    if (type === "mcpToolCall" && bridge) {
                      if (phase !== 4 || result) throw invalid();
                      if (message.method === "item/started")
                        bridge.started(item);
                      else bridge.completed(item);
                      context.reportProgress();
                      return;
                    }
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
                    if (bridge?.interrupted) {
                      if (result || turn.status !== "interrupted")
                        throw invalid();
                      result = {
                        text,
                        toolCalls: bridge.finish(),
                        ...(usage ? { usage } : {}),
                      };
                      end();
                      return;
                    }
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
        signal.throwIfAborted();
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
        await bridge?.close();
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
