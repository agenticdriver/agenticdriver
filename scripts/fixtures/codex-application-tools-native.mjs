// Production adapter + real native executable, isolated by test-codex-native.py.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "/tmp/fixture-sdk/dist/index.js";
import { codex } from "/tmp/fixture-sdk/dist/providers/index.js";
import { AgenticClient } from "/tmp/fixture-sdk/dist/client.js";
import { serve } from "/tmp/fixture-sdk/dist/server.js";

const root = "/tmp/fixture-work",
  model = "gpt-6-luna";
const account = `${root}/account`;
await mkdir(account);
await writeFile(
  `${account}/auth.json`,
  JSON.stringify({ OPENAI_API_KEY: "synthetic-mcp-bridge" }),
  { mode: 0o600 },
);
await writeFile(
  `${account}/config.toml`,
  `[mcp_servers.ambient]\ncommand="/tmp/fixture-node"\nargs=["-e","require('node:fs').writeFileSync('${root}/ambient-started','unexpected')"]\n`,
);
await writeFile(
  `${account}/hooks.json`,
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `/tmp/fixture-node -e "require('node:fs').writeFileSync('${root}/hook-started','unexpected')"`,
            },
          ],
        },
      ],
    },
  }),
);
let scenario, requests, executions, approvals, failure, controller;
const receipts = [],
  records = [];
const selected = "SELECTED_APPLICATION_PASSAGE";
const strings = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(strings)
      : [];
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer synthetic-mcp-bridge");
    const request = JSON.parse(body);
    assert.equal(request.model, model);
    assert.equal(request.reasoning.effort, "medium");
    requests.push(request);
    const declarations = strings(request.tools).join("\n");
    assert.doesNotMatch(
      declarations,
      /exec_command|apply_patch|spawn_agent|mcp__ambient/,
    );
    if (requests.length > 1) {
      assert.ok(
        ["roundtrip", "concurrent", "remote-roundtrip"].includes(scenario),
        `Unexpected native continuation for ${scenario}`,
      );
      assert.equal(executions, scenario === "concurrent" ? 2 : 1);
      const proposed = request.input.filter(
        (item) => item.type === "function_call",
      );
      const results = request.input.filter(
        (item) => item.type === "function_call_output",
      );
      assert.equal(proposed.length, executions);
      assert.equal(
        new Set(proposed.map((call) => call.call_id)).size,
        executions,
      );
      assert.equal(results.length, executions);
      for (const result of results) {
        assert.ok(
          proposed.some(
            (call) =>
              call.call_id === result.call_id &&
              /^mcp__agenticdriver_[a-f0-9]+__fixture_read$/.test(call.name) &&
              JSON.parse(call.arguments).key === "selected",
          ),
        );
        assert.equal(JSON.parse(result.output).passage, selected);
      }
    }
    const expression =
      scenario === "concurrent" || scenario === "invalid-batch"
        ? `text(await Promise.all([tools[t.name]({key:"selected"}),tools[t.name]({key:${JSON.stringify(scenario === "invalid-batch" ? "forbidden" : "selected")}})]));`
        : `text(await tools[t.name]({key:"selected"}));`;
    const registryExpression = `text(await tools[t.name]({key:"selected",registry:ALL_TOOLS.map(x=>x.name),globals:{fetch:typeof fetch,process:typeof process,require:typeof require}}));`;
    const item =
      requests.length === 1
        ? {
            type: "custom_tool_call",
            namespace: "functions",
            name: "exec",
            id: "native-call",
            call_id: "native-call",
            status: "completed",
            input: `const t=ALL_TOOLS.find(x=>x.name.endsWith("__fixture_read")); ${scenario === "registry" ? registryExpression : expression}`,
          }
        : {
            type: "message",
            id: "native-answer",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: selected, annotations: [] }],
          };
    const response = {
      id: `response_${requests.length}`,
      object: "response",
      model,
      status: "completed",
      output: [item],
      ...(scenario === "missing-usage"
        ? {}
        : {
            usage: {
              input_tokens: 11,
              output_tokens: 5,
              total_tokens: 16,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
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
    failure = error;
    res.destroy();
    controller.abort(error);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const overrides = [
  'model_provider="fixture"',
  `model_providers.fixture={name="Offline MCP bridge",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
  'cli_auth_credentials_store="file"',
  "analytics.enabled=false",
  "feedback.enabled=false",
];
const wrapper = `${root}/codex-fixture`;
await writeFile(
  wrapper,
  `#!/tmp/fixture-node
const {spawn}=require('node:child_process');const fs=require('node:fs');
const args=process.argv.slice(2);const extra=${JSON.stringify(overrides)}.flatMap(v=>['--config',v]);
const child=spawn('/tmp/fixture-codex',[...args,...extra],{stdio:'pipe'});
child.stdout.on('data',c=>fs.appendFileSync('${root}/wire.jsonl',c));
child.stderr.on('data',c=>fs.appendFileSync('${root}/stderr.txt',c));
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('error',()=>process.exitCode=1);child.once('close',code=>process.exitCode=code??1);
`,
  { mode: 0o700 },
);
const survivors = async () => {
  const alive = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const args = (
      await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
    ).split("\0");
    if (
      ["/tmp/fixture-codex", "/tmp/codex-code-mode-host"].includes(args[0]) ||
      args.some((arg) => arg.endsWith("/codex-mcp-helper.js"))
    )
      alive.push(Number(pid));
  }
  return alive;
};
const noNative = async () => {
  for (let attempt = 0; attempt < 100 && (await survivors()).length; attempt++)
    await delay(20);
  assert.deepEqual(
    await survivors(),
    [],
    "Native processes must be gone before SDK approval/application execution.",
  );
  assert.deepEqual(
    (await readdir("/tmp")).filter((name) => name.startsWith("agenticdriver-")),
    [],
    "Private manifests and working directories must be removed.",
  );
};
const tool = {
  name: "fixture_read",
  description: "Read the selected synthetic passage.",
  inputSchema: {
    type: "object",
    properties: { key: { const: "selected" } },
    required: ["key"],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute() {
    await noNative();
    executions++;
    if (scenario === "cancel-tool") controller.abort();
    // This work occurs after native MCP has closed, outside its fixed timeout.
    await delay(30);
    return { passage: selected };
  },
};
const provider = codex({
  binary: wrapper,
  accountDirectory: account,
  reasoningEffort: "medium",
  applicationTools: "mcp",
});
assert.equal(provider.info.capabilities.tools, true);
assert.equal(
  codex({ binary: wrapper, accountDirectory: account }).info.capabilities.tools,
  false,
);
try {
  for (scenario of [
    "roundtrip",
    "concurrent",
    "invalid-batch",
    "denied",
    "missing-usage",
    "cancel-tool",
  ]) {
    requests = [];
    executions = 0;
    approvals = 0;
    failure = undefined;
    controller = new AbortController();
    const driver = new AgenticDriver({
      providers: [provider],
      tools: [tool],
      approve: async () => {
        await noNative();
        approvals++;
        return scenario !== "denied";
      },
      onUsage: (record) => {
        records.push(record);
      },
      ...(scenario === "missing-usage"
        ? { resources: { default: { maxTokens: 100, unknownUsage: "reject" } } }
        : {}),
    });
    const events = [];
    for await (const event of driver.stream(
      {
        provider: "codex",
        model,
        input: "Read only the selected passage.",
        tools: ["fixture_read"],
        retry: { maxAttempts: 1 },
      },
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20_000),
        ]),
      },
    ))
      events.push(event);
    if (failure) throw failure;
    const terminal = events.at(-1);
    const expected = {
      "invalid-batch": "INVALID_TOOL_ARGUMENTS",
      denied: "APPROVAL_REQUIRED",
      "missing-usage": "RESOURCE_USAGE_UNKNOWN",
      "cancel-tool": "CANCELLED",
    }[scenario];
    if (expected) {
      assert.equal(
        terminal.type,
        scenario === "cancel-tool" ? "run.cancelled" : "run.failed",
        JSON.stringify(terminal),
      );
      assert.equal(terminal.error.code, expected, JSON.stringify(terminal));
      assert.equal(requests.length, 1);
      assert.equal(executions, scenario === "cancel-tool" ? 1 : 0);
      if (["invalid-batch", "missing-usage"].includes(scenario))
        assert.equal(approvals, 0);
    } else {
      assert.equal(terminal.type, "run.completed", JSON.stringify(terminal));
      assert.equal(terminal.result.text, selected);
      assert.equal(requests.length, 2);
      assert.equal(executions, scenario === "concurrent" ? 2 : 1);
      assert.equal(approvals, executions);
      assert.deepEqual(terminal.result.usage, {
        inputTokens: 22,
        outputTokens: 10,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      });
    }
    await noNative();
    receipts.push({
      name: scenario,
      status: "passed",
      nativeRequests: requests.length,
      executions,
      approvals,
      outcome: terminal.type,
      usage: records.at(-1)?.usage,
    });
  }
  for (scenario of ["remote-roundtrip", "remote-denied"]) {
    requests = [];
    executions = 0;
    approvals = 0;
    failure = undefined;
    controller = new AbortController();
    const driver = new AgenticDriver({
      providers: [provider],
      applicationTools: { enabled: true },
      approvals: { interactive: true },
      onUsage: (record) => records.push(record),
    });
    const token = "synthetic-mcp-remote-client-credential";
    const host = await serve(driver, {
      port: 0,
      tokens: [
        {
          token,
          subject: "fixture-application",
          providers: ["codex"],
          applicationTools: [{ name: "fixture_read", requiresApproval: true }],
          approveTools: ["fixture_read"],
        },
      ],
    });
    try {
      const client = new AgenticClient({ url: host.url, token });
      const events = [];
      for await (const event of client.stream(
        {
          provider: "codex",
          model,
          input: "Read the selected passage.",
          tools: [tool.name],
          applicationTools: [
            {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            },
          ],
          approvals: { mode: "interactive", idlePolicy: "pause" },
          retry: { maxAttempts: 1 },
        },
        { signal: AbortSignal.timeout(20_000) },
      )) {
        events.push(event);
        if (event.type === "approval.requested") {
          await noNative();
          approvals++;
          const { approvalId, runId, call } = event.approval;
          await client.decideApproval({
            approvalId,
            runId,
            call,
            decision: scenario === "remote-denied" ? "deny" : "approve",
          });
        }
        if (event.type === "tool.execution.requested") {
          await noNative();
          executions++;
          const { executionId, runId, call } = event.execution;
          assert.deepEqual(call.arguments, { key: "selected" });
          await client.completeTool({
            executionId,
            runId,
            callId: call.id,
            output: { passage: selected },
          });
        }
      }
      if (failure) throw failure;
      const terminal = events.at(-1);
      assert.equal(approvals, 1);
      if (scenario === "remote-denied") {
        assert.equal(terminal.type, "run.failed", JSON.stringify(terminal));
        assert.equal(terminal.error.code, "APPROVAL_DENIED");
        assert.equal(requests.length, 1);
        assert.equal(executions, 0);
      } else {
        assert.equal(terminal.type, "run.completed", JSON.stringify(terminal));
        assert.equal(terminal.result.text, selected);
        assert.equal(requests.length, 2);
        assert.equal(executions, 1);
      }
      receipts.push({
        name: scenario,
        status: "passed",
        nativeRequests: requests.length,
        executions,
        approvals,
        outcome: terminal.type,
        usage: records.at(-1)?.usage,
      });
    } finally {
      await host.close();
    }
  }
  scenario = "cancel-proposal";
  requests = [];
  executions = 0;
  controller = new AbortController();
  await assert.rejects(
    provider.complete(
      {
        model,
        messages: [{ role: "user", content: "Read the selected passage." }],
        tools: [tool],
        maxOutputTokens: 100,
      },
      {
        runId: "fixture-cancellation",
        subject: "fixture",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20_000),
        ]),
        emitText() {},
        reportProgress() {
          controller.abort();
        },
      },
    ),
    { code: "CANCELLED" },
  );
  await noNative();
  assert.equal(requests.length, 1);
  receipts.push({
    name: scenario,
    status: "passed",
    nativeRequests: 1,
    executions: 0,
  });
  scenario = "registry";
  requests = [];
  controller = new AbortController();
  const registry = await provider.complete(
    {
      model,
      messages: [{ role: "user", content: "Inspect fixture restrictions." }],
      tools: [{ ...tool, inputSchema: { type: "object" } }],
      maxOutputTokens: 100,
    },
    {
      runId: "fixture-registry",
      subject: "fixture",
      signal: AbortSignal.timeout(20_000),
      emitText() {},
      reportProgress() {},
    },
  );
  const args = registry.toolCalls[0].arguments;
  const expected = [
    "clock__curr_time",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "read_mcp_resource",
  ];
  assert.deepEqual(
    args.registry
      .filter(
        (name) => !/^mcp__agenticdriver_[a-f0-9]+__fixture_read$/.test(name),
      )
      .sort(),
    expected.sort(),
  );
  assert.equal(args.registry.length, 5);
  assert.deepEqual(args.globals, {
    fetch: "undefined",
    process: "undefined",
    require: "undefined",
  });
  assert.equal(requests.length, 1);
  await noNative();
  receipts.push({
    name: scenario,
    status: "passed",
    nativeRequests: 1,
    executions: 0,
    nativeGlobalsUnavailable: true,
    allowedRegistry: [...expected, "owned fixture_read"],
  });
  for (const marker of ["ambient-started", "hook-started"])
    await assert.rejects(access(`${root}/${marker}`), { code: "ENOENT" });
  console.log(
    JSON.stringify({
      version: "codex-cli 0.157.0",
      model,
      reasoningEffort: "medium",
      ambientMcpStarted: false,
      hooksStarted: false,
      nativeProcessesReaped: true,
      cases: receipts,
    }),
  );
} catch (error) {
  console.error("Scenario:", scenario, "requests:", requests?.length);
  console.error(
    (await readFile(`${root}/wire.jsonl`, "utf8").catch(() => "")).slice(
      -12000,
    ),
  );
  console.error(
    (await readFile(`${root}/stderr.txt`, "utf8").catch(() => "")).slice(-2000),
  );
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
