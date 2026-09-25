// Protocol characterization, not a production provider or application-tool executor.
// test-codex-native.py runs this with synthetic credentials and no external network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "/tmp/fixture-sdk/dist/providers/cli-process.js";

const root = "/tmp/fixture-work";
const model = "gpt-6-luna";
const tool = {
  name: "fixture_read",
  description: "Read the selected synthetic passage.",
  inputSchema: {
    type: "object",
    properties: { key: { const: "selected" } },
    required: ["key"],
    additionalProperties: false,
  },
};

// A deliberately pending stdio MCP tool. Progress continues past the native
// client's explicitly configured timeout. No application effects are performed.
if (process.argv[2] === "--mcp-server") {
  const endpoint = process.argv[3];
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const intervals = new Set();
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize")
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "agenticdriver-offline-audit", version: "1" },
          },
        });
      else if (message.method === "tools/list")
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                ...tool,
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ],
          },
        });
      else if (message.method === "tools/call") {
        assert.equal(message.params.name, tool.name);
        assert.deepEqual(message.params.arguments, { key: "selected" });
        let progress = 0;
        const tick = () => {
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken: message.params._meta?.progressToken ?? message.id,
              progress: ++progress,
            },
          });
          // Inform only the isolated fixture of actual emitted progress.
          void fetch(endpoint, {
            method: "POST",
            body: JSON.stringify({
              progress,
              requested: message.params._meta?.progressToken !== undefined,
            }),
          }).catch(() => {});
        };
        tick();
        intervals.add(setInterval(tick, 25));
      } else if (message.id !== undefined)
        send({ jsonrpc: "2.0", id: message.id, result: {} });
    })
    .on("close", () => {
      for (const interval of intervals) clearInterval(interval);
    });
} else {
  await audit();
}

async function audit() {
  const account = `${root}/tools-account`;
  await mkdir(account);
  await writeFile(
    `${account}/auth.json`,
    JSON.stringify({ OPENAI_API_KEY: "synthetic-tool-audit" }),
    { mode: 0o600 },
  );
  await writeFile(
    `${account}/config.toml`,
    `
[mcp_servers.ambient]
command="/tmp/fixture-node"
args=["-e","require('node:fs').writeFileSync('${root}/ambient-started','unexpected')"]
`,
  );
  const env = { ...process.env, CODEX_HOME: account };
  const version = (
    await runProcess("/tmp/fixture-codex", ["--version"], {
      env,
      signal: AbortSignal.timeout(10_000),
    })
  ).trim();
  assert.equal(version, "codex-cli 0.157.0");
  const cases = [];
  for (const scenario of [
    "dynamic-roundtrip",
    "dynamic-denied",
    "dynamic-cancel",
    "mcp-progress-timeout",
  ])
    cases.push(await characterize(scenario, env));
  await assert.rejects(access(`${root}/ambient-started`), { code: "ENOENT" });
  const survivors = async () => {
    const result = [];
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
        () => "",
      );
      const args = command.split("\0");
      if (
        ["/tmp/fixture-codex", "/tmp/codex-code-mode-host"].includes(args[0]) ||
        args.includes("--mcp-server")
      )
        result.push(Number(pid));
    }
    return result;
  };
  for (let attempt = 0; attempt < 100 && (await survivors()).length; attempt++)
    await delay(20);
  assert.deepEqual(
    await survivors(),
    [],
    "All owned native/MCP processes must be reaped.",
  );
  console.log(
    JSON.stringify({
      version,
      model,
      reasoningEffort: "medium",
      productionBridgeEnabled: false,
      ambientMcpStarted: false,
      nativeProcessesReaped: true,
      cases,
    }),
  );
}

async function characterize(scenario, env) {
  const mcp = scenario.startsWith("mcp-");
  const events = [];
  const bodies = [];
  const usage = [];
  let progressCount = 0;
  let progressRequested = false;
  let nativeProgressNotifications = 0;
  let serverFailure;
  let nativeToolName = tool.name;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const part of req) raw += part;
      if (req.url === "/mcp-progress") {
        progressCount++;
        progressRequested ||= JSON.parse(raw).requested;
        res.end("ok");
        return;
      }
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer synthetic-tool-audit");
      const body = JSON.parse(raw);
      assert.equal(body.model, model);
      assert.equal(body.reasoning?.effort, "medium");
      bodies.push(body);
      events.push(`model-request:${bodies.length}`);
      const allTools = [
        ...(body.tools ?? []),
        ...(body.input ?? []).flatMap((item) => item.tools ?? []),
      ];
      const declarations = allTools
        .flatMap((entry) =>
          entry.type === "namespace" ? entry.tools : [entry],
        )
        .flatMap((entry) =>
          [...(entry.description ?? "").matchAll(/^### `([^`]+)`/gm)].map(
            (match) => match[1],
          ),
        );
      nativeToolName = mcp
        ? "mcp__audit__fixture_read"
        : declarations.find((name) => name === tool.name);
      assert.ok(
        nativeToolName,
        "The native catalog must expose the selected dynamic fixture tool.",
      );
      assert.deepEqual(
        declarations.slice().sort(),
        mcp
          ? [
              "clock__curr_time",
              "list_mcp_resource_templates",
              "list_mcp_resources",
              "read_mcp_resource",
            ].sort()
          : [nativeToolName, "clock__curr_time"].sort(),
      );
      const item =
        bodies.length === 1 && mcp
          ? {
              type: "custom_tool_call",
              namespace: "functions",
              name: "exec",
              id: "fc_fixture",
              call_id: "call_fixture",
              status: "completed",
              input: `text(await tools.${nativeToolName}({key:"selected"}));`,
            }
          : bodies.length === 1
            ? {
                type: "function_call",
                id: "fc_fixture",
                call_id: "call_fixture",
                name: nativeToolName,
                arguments: JSON.stringify({ key: "selected" }),
                status: "completed",
              }
            : {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "Fixture complete.",
                    annotations: [],
                  },
                ],
              };
      const response = {
        id: `response_${bodies.length}`,
        object: "response",
        model,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      serverFailure = error;
      res.destroy();
      controller.abort(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const config = [
    'model_provider="fixture"',
    `model_providers.fixture={name="Offline tool protocol fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
    'cli_auth_credentials_store="file"',
    "analytics.enabled=false",
    "feedback.enabled=false",
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
    ...(mcp
      ? [
          `mcp_servers.audit={command="/tmp/fixture-node",args=["/tmp/fixture-sdk/scripts/fixtures/codex-tools-native.mjs","--mcp-server","http://127.0.0.1:${port}/mcp-progress"],required=true,tool_timeout_sec=0.25,enabled_tools=["fixture_read"]}`,
        ]
      : []),
  ];
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(20_000),
  ]); // Test watchdog only.
  let send,
    end,
    nextId = 1,
    threadId,
    toolRequests = 0,
    stderr = "";
  const pending = new Map();
  const terminal = Promise.withResolvers();
  // Install handlers before launching, so an early native exit never leaks a rejection.
  void terminal.promise.catch(() => {});
  const rpc = (method, params) => {
    const id = nextId++;
    const result = Promise.withResolvers();
    pending.set(id, result);
    send({ id, method, params });
    return result.promise;
  };
  const operation = runProcess(
    "/tmp/fixture-codex",
    [
      "app-server",
      "--stdio",
      "--strict-config",
      ...config.flatMap((value) => ["--config", value]),
    ],
    {
      env,
      cwd: root,
      signal,
      retainOutput: false,
      classifyExit(_code, value) {
        stderr = value;
      },
      onStart(write, close) {
        send = (message) => write(JSON.stringify(message) + "\n");
        end = close;
      },
      onLine(line) {
        const message = JSON.parse(line);
        if (message.method === "item/tool/call") {
          toolRequests++;
          assert.equal(message.params.threadId, threadId);
          assert.equal(message.params.tool, tool.name);
          assert.deepEqual(message.params.arguments, { key: "selected" });
          events.push("tool-request");
          if (scenario === "dynamic-cancel") {
            events.push("interrupt-request");
            void rpc("turn/interrupt", {
              threadId,
              turnId: message.params.turnId,
            }).catch((error) => controller.abort(error));
          } else {
            events.push("tool-response");
            send(
              scenario === "dynamic-denied"
                ? {
                    id: message.id,
                    error: { code: -32000, message: "Fixture tool denied." },
                  }
                : {
                    id: message.id,
                    result: {
                      contentItems: [
                        {
                          type: "inputText",
                          text: '{"passage":"SELECTED_FIXTURE_PASSAGE"}',
                        },
                      ],
                      success: true,
                    },
                  },
            );
          }
        } else if (message.method) {
          assert.equal(
            message.id,
            undefined,
            "An unexpected native authority request must fail the fixture.",
          );
          if (message.method === "item/mcpToolCall/progress")
            nativeProgressNotifications++;
          if (message.method === "thread/tokenUsage/updated") {
            events.push("usage-reported");
            usage.push(message.params.tokenUsage.total);
          }
          if (message.method === "turn/completed")
            terminal.resolve(message.params.turn);
        } else if (pending.has(message.id)) {
          const deferred = pending.get(message.id);
          pending.delete(message.id);
          if (message.error)
            deferred.reject(new Error(JSON.stringify(message.error)));
          else deferred.resolve(message.result);
        }
      },
    },
  );
  const finished = operation.then(
    () => {
      const error = new Error(
        "Native process exited before a completed response.",
      );
      terminal.reject(error);
      for (const deferred of pending.values()) deferred.reject(error);
    },
    (error) => {
      terminal.reject(error);
      for (const deferred of pending.values()) deferred.reject(error);
    },
  );
  try {
    await rpc("initialize", {
      clientInfo: { name: "agenticdriver_tool_audit", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const current = await rpc("config/read", { includeLayers: false });
    const overrides = Object.fromEntries(
      Object.keys(current.config.mcp_servers ?? {})
        .filter((name) => !mcp || name !== "audit")
        .map((name) => [`mcp_servers.${name}.enabled`, false]),
    );
    const started = await rpc("thread/start", {
      model,
      allowProviderModelFallback: false,
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
      selectedCapabilityRoots: [],
      config: overrides,
      dynamicTools: mcp
        ? []
        : [{ type: "function", ...tool, deferLoading: false }],
    });
    threadId = started.thread.id;
    await rpc("turn/start", {
      threadId,
      model,
      effort: "medium",
      environments: [],
      input: [
        {
          type: "text",
          text: "Read the selected fixture passage, then return its content.",
        },
      ],
    });
    const turn = await terminal.promise;
    end();
    await operation;
    if (serverFailure) throw serverFailure;
    assert.equal(toolRequests, mcp ? 0 : 1);
    if (scenario === "dynamic-cancel") {
      assert.equal(turn.status, "interrupted");
      assert.equal(
        bodies.length,
        1,
        "Cancellation must prevent another native model request.",
      );
      assert.ok(!events.includes("tool-response"));
    } else {
      assert.equal(turn.status, "completed");
      assert.equal(
        bodies.length,
        2,
        "The native loop, not the SDK, starts the continuation request.",
      );
      assert.deepEqual(usage.at(-1), {
        totalTokens: 32,
        inputTokens: 22,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      });
      if (!mcp)
        assert.ok(
          events.indexOf("usage-reported") > events.indexOf("tool-response"),
          "Current-generation usage arrives after responding to the native tool call.",
        );
      const continued = JSON.stringify(bodies[1]);
      if (scenario === "dynamic-roundtrip")
        assert.match(continued, /SELECTED_FIXTURE_PASSAGE/);
      else if (scenario === "dynamic-denied")
        assert.match(continued, /dynamic tool request failed/);
      else {
        assert.ok(
          progressCount >= 2,
          `MCP must report actual progress before timing out: ${JSON.stringify(bodies[1].input.filter((item) => item.type.endsWith("_output")))}`,
        );
        assert.match(continued, /timed out|timeout/i);
      }
    }
    return {
      name: scenario,
      status: "passed",
      events,
      nativeRequests: bodies.length,
      clientToolRequests: toolRequests,
      mcpProgressReports: progressCount,
      mcpProgressRequested: progressRequested,
      nativeProgressNotifications,
      reportedUsage: usage.at(-1) ?? null,
    };
  } catch (error) {
    if (serverFailure) console.error("Fixture HTTP error:", serverFailure);
    if (stderr) console.error(stderr.slice(-3000));
    console.error("Native tool audit:", scenario, events);
    throw error;
  } finally {
    controller.abort();
    await finished;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
