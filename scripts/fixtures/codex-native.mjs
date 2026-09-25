// Launched only by test-codex-native.py in a fresh filesystem/network namespace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "/tmp/fixture-sdk/dist/index.js";
import { codex } from "/tmp/fixture-sdk/dist/providers/index.js";

const root = "/tmp/fixture-work";
const model = "gpt-6-luna"; // A fixture identifier, never a live account/model selection.
const reasoningEffort = "medium";
const answer = "Native fixture completed.";
const accounts = ["one", "two"].map((name) => `${root}/account-${name}`);
const secret = "PRIVATE_NATIVE_DIAGNOSTIC";
const markers = {
  globalInstructions: "GLOBAL_GUIDANCE_MARKER",
  globalSkillCatalog: "GLOBAL_SKILL_MARKER",
  userConfiguration: "IGNORED_USER_CONFIG_MARKER",
  parentInstructions: "PARENT_GUIDANCE_MARKER",
};

for (const [index, account] of accounts.entries()) {
  await mkdir(account, { recursive: true });
  // Entirely synthetic credentials: the namespace cannot reach a real provider.
  await writeFile(
    `${account}/auth.json`,
    JSON.stringify({
      OPENAI_API_KEY: `fixture-account-${index}`,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    `${account}/config.toml`,
    `
model="wrong-configured-model"
developer_instructions="${markers.userConfiguration}"
[mcp_servers.fixture]
command="/tmp/fixture-node"
args=["-e","require('node:fs').writeFileSync('${root}/mcp-started','unexpected')"]
`,
  );
  await writeFile(`${account}/AGENTS.md`, markers.globalInstructions);
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
}
const skill = `${homedir()}/.agents/skills/fixture-ambient`;
await mkdir(skill, { recursive: true });
await writeFile(
  `${skill}/SKILL.md`,
  `---\nname: fixture-ambient\ndescription: ${markers.globalSkillCatalog}\n---\nSynthetic global skill.\n`,
);
await writeFile("/tmp/AGENTS.md", markers.parentInstructions);
// Test that the SDK's environment allowlist does not select this credential.
process.env.OPENAI_API_KEY = "fixture-ambient-account-must-not-be-used";

const { stdout: versionOutput } = await promisify(execFile)(
  "/tmp/fixture-codex",
  ["--version"],
  { env: { ...process.env, CODEX_HOME: accounts[0] } },
);
const version = versionOutput.trim();
assert.match(version, /^codex-cli \d+\.\d+\.\d+/);
let scenario = "success";
let selectedAccount = 0;
let cancel;
let resolveClosed;
let activeResponse;
let sessionAccessToken;
let sessionRefreshedToken;
let sessionIdToken;
const requests = [];
const refreshRequests = [];
const cases = [];
let serverFailure;
let scenarioRequests = 0;
const nativeTools = (request) => {
  const flatten = (tools, namespace = "") =>
    tools.flatMap((tool) =>
      tool.type === "namespace"
        ? flatten(tool.tools, `${namespace}${tool.name}.`)
        : [
            {
              type: tool.type,
              name: `${namespace}${tool.name}`,
              declarations: [
                ...(tool.description ?? "").matchAll(/^### `([^`]+)`/gm),
              ].map((match) => match[1]),
            },
          ],
    );
  return flatten([
    ...(request.tools ?? []),
    ...(request.input ?? [])
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => item.tools),
  ]);
};
const expectedTools = [
  {
    type: "custom",
    name: "functions.exec",
    declarations: ["clock__curr_time"],
  },
  { type: "function", name: "functions.wait", declarations: [] },
  {
    type: "function",
    name: "functions.request_user_input_async",
    declarations: [],
  },
];
const forbiddenCalls = {
  shell: {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: "/tmp/fixture-node -e \"require('node:fs').writeFileSync('/tmp/fixture-work/forbidden-created','unexpected')\"",
    }),
  },
  patch: {
    type: "custom_tool_call",
    name: "apply_patch",
    input:
      "*** Begin Patch\n*** Add File: /tmp/fixture-work/forbidden-created\n+unexpected\n*** End Patch",
  },
  image: {
    type: "function_call",
    name: "view_image",
    arguments: JSON.stringify({ path: `${root}/private-source.png` }),
  },
  spawn: {
    type: "function_call",
    namespace: "collaboration",
    name: "spawn_agent",
    arguments: JSON.stringify({
      task_name: "forbidden",
      message: "Return forbidden.",
    }),
  },
  nestedShell: {
    type: "custom_tool_call",
    namespace: "functions",
    name: "exec",
    input:
      "text(await tools.exec_command({cmd: \"/tmp/fixture-node -e \\\"require('node:fs').writeFileSync('/tmp/fixture-work/forbidden-created','unexpected')\\\"\"}));",
  },
  import: {
    type: "custom_tool_call",
    namespace: "functions",
    name: "exec",
    input:
      "text((await import('node:fs')).readFileSync('/tmp/fixture-work/private-context.txt','utf8'));",
  },
  fetch: {
    type: "custom_tool_call",
    namespace: "functions",
    name: "exec",
    input:
      "text(await fetch('http://127.0.0.1:FIXTURE_PORT/forbidden-network'));",
  },
  mcp: { type: "function_call", name: "mcp__fixture__read", arguments: "{}" },
  goal: {
    type: "function_call",
    name: "create_goal",
    arguments: '{"objective":"Unrequested fixture goal"}',
  },
};
const registryCall = {
  type: "custom_tool_call",
  namespace: "functions",
  name: "exec",
  input:
    "text({tools:ALL_TOOLS.map(tool=>tool.name),fetch:typeof fetch,process:typeof process,require:typeof require,Deno:typeof Deno});",
};
await writeFile(`${root}/private-context.txt`, "FORBIDDEN_CONTEXT_MARKER");
await writeFile(
  `${root}/private-source.png`,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=",
    "base64",
  ),
);

const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const data of req) raw += data;
    if (req.url.startsWith("/v1/models?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url === "/oauth/token") {
      const body = JSON.parse(raw);
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "fixture-session-refresh");
      refreshRequests.push({ scenario });
      res.writeHead(scenario === "session-refresh" ? 200 : 401, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          scenario === "session-refresh"
            ? {
                access_token: sessionRefreshedToken,
                id_token: sessionIdToken,
                refresh_token: "fixture-session-rotated",
              }
            : {
                error: {
                  code: `refresh_token_${scenario.slice("session-".length)}`,
                  message: secret,
                },
              },
        ),
      );
      return;
    }
    assert.equal(req.url, "/v1/responses");
    assert.equal(
      req.headers.authorization,
      scenario.startsWith("session-")
        ? `Bearer ${scenario === "session-refresh" ? sessionRefreshedToken : sessionAccessToken}`
        : `Bearer fixture-account-${selectedAccount}`,
      `scenario ${scenario}; refresh requests ${refreshRequests.length}`,
    );
    const body = JSON.parse(raw);
    requests.push(body);
    scenarioRequests++;
    assert.equal(body.model, model);
    assert.equal(body.reasoning?.effort, reasoningEffort);
    // Responses Lite puts tools in additional_tools input items, not body.tools.
    assert.deepEqual(nativeTools(body), expectedTools);
    const content = JSON.stringify(body);
    assert.ok(content.includes("Supplied application context."));
    assert.ok(!content.includes(markers.userConfiguration));
    assert.ok(!content.includes(markers.parentInstructions));
    assert.ok(!content.includes("FORBIDDEN_CONTEXT_MARKER"));
    if (scenario.startsWith("session-") && scenario !== "session-refresh") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "token_expired", message: secret } }),
      );
      return;
    }
    if (["auth", "rate", "model", "unavailable"].includes(scenario)) {
      const [status, code, message] = {
        auth: [
          401,
          "invalid_api_key",
          "Your authentication token is expired. Please try signing in again.",
        ],
        rate: [429, "rate_limit_exceeded", "Rate limit reached."],
        model: [
          404,
          "model_not_found",
          "The model fixture-model does not exist.",
        ],
        unavailable: [503, "server_error", "Service temporarily unavailable."],
      }[scenario];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code, type: code, message: `${message} ${secret}` },
        }),
      );
      return;
    }
    const rejectedTool =
      forbiddenCalls[scenario.slice("forbidden-".length)] ?? registryCall;
    const item =
      (scenario.startsWith("forbidden-") || scenario === "registry") &&
      scenarioRequests === 1
        ? {
            ...rejectedTool,
            ...(rejectedTool.input
              ? {
                  input: rejectedTool.input.replace(
                    "FIXTURE_PORT",
                    String(port),
                  ),
                }
              : {}),
            id: "tool-fixture",
            call_id: "forbidden-call",
            status: "completed",
          }
        : {
            id: "message-fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          };
    const response = {
      id: "response-fixture",
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
    const send = (event) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    if (scenario === "cancel") {
      activeResponse = res;
      res.once("close", () => resolveClosed());
      cancel();
      return;
    }
    for (const event of [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          ...item,
          status: "in_progress",
          ...(item.type === "message" ? { content: [] } : {}),
        },
      },
      ...(item.type === "message"
        ? [
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: answer,
            },
          ]
        : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ])
      send(event);
    res.end();
  } catch (error) {
    serverFailure = error;
    res.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const overrides = [
  'model_provider="fixture"',
  `model_providers.fixture={name="Local protocol fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
  'cli_auth_credentials_store="file"',
  "analytics.enabled=false",
  "feedback.enabled=false",
];
// The wrapper adds only fixture endpoints/credential-store/telemetry settings.
// All execution-policy flags come from the actual SDK adapter under test.
const wrapper = `${root}/codex-fixture`;
await writeFile(
  wrapper,
  `#!/tmp/fixture-node
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
const extra=${JSON.stringify(overrides)}.flatMap(value=>['--config',value]);
const child=spawn('/tmp/fixture-codex',[...args,...extra],{stdio:'pipe',env:{...process.env,CODEX_REFRESH_TOKEN_URL_OVERRIDE:'http://127.0.0.1:${port}/oauth/token'}});
child.stdout.on('data',chunk=>fs.appendFileSync('${root}/native-wire.jsonl',chunk));
child.stderr.on('data',chunk=>fs.appendFileSync('${root}/native-stderr.txt',chunk));
fs.appendFileSync('${root}/native-pids.jsonl',JSON.stringify({pid:child.pid,execution:args[0]==='app-server'&&args.includes('--stdio')})+'\\n');
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error',()=>process.exitCode=1);
child.once('close',code=>process.exitCode=code??1);
`,
  { mode: 0o700 },
);

const providers = accounts.map((accountDirectory, index) =>
  codex({
    id: `account-${index}`,
    binary: wrapper,
    accountDirectory,
    reasoningEffort,
  }),
);
const driver = new AgenticDriver({ providers });
const request = () => ({
  provider: `account-${selectedAccount}`,
  model,
  input: "Supplied application context.",
});
const watch = () => AbortSignal.timeout(20_000); // Fixture watchdog only.
const executionCount = async () =>
  (await readFile(`${root}/native-pids.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.execution).length;
try {
  for (
    selectedAccount = 0;
    selectedAccount < accounts.length;
    selectedAccount++
  ) {
    scenario = "success";
    const before = requests.length;
    const events = [];
    for await (const event of driver.stream(request(), { signal: watch() }))
      events.push(event);
    if (serverFailure) throw serverFailure;
    const terminal = events.at(-1);
    if (terminal.type === "run.failed") {
      const wire = await readFile(`${root}/native-wire.jsonl`, "utf8");
      console.error(
        wire
          .split("\n")
          .filter((line) => {
            try {
              return JSON.parse(line).error;
            } catch {
              return false;
            }
          })
          .join("\n"),
      );
      console.error(
        (
          await readFile(`${root}/native-stderr.txt`, "utf8").catch(() => "")
        ).slice(-1500),
      );
    }
    assert.equal(terminal.type, "run.completed", JSON.stringify(terminal));
    assert.equal(terminal.result.text, answer);
    assert.deepEqual(terminal.result.usage, {
      inputTokens: 11,
      outputTokens: 5,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    assert.equal(
      events
        .filter((event) => event.type === "text.delta")
        .map((event) => event.text)
        .join(""),
      answer,
    );
    assert.equal(requests.length - before, 1);
    assert.equal(
      providers[selectedAccount].info.capabilities.textStreaming,
      false,
    );
    cases.push({
      name: `account-${selectedAccount}-text-progress-usage`,
      status: "passed",
    });
  }
  selectedAccount = 0;
  for (const [name, code] of [
    ["auth", "CLI_AUTH_REQUIRED"],
    ["rate", "RATE_LIMITED"],
    ["model", "UNSUPPORTED_MODEL"],
    ["unavailable", "CLI_FAILED"],
  ]) {
    scenario = name;
    const before = requests.length;
    await assert.rejects(
      driver.run(request(), { signal: watch() }),
      (error) => {
        if (serverFailure) throw serverFailure;
        assert.equal(error.code, code);
        assert.equal(error.retryable, name === "rate");
        assert.ok(!JSON.stringify(error).includes(secret));
        assert.doesNotMatch(
          JSON.stringify(error),
          /127\.0\.0\.1|fixture-account/,
        );
        return true;
      },
    );
    assert.equal(requests.length - before, 1);
    cases.push({ name: `${name}-error`, status: "passed" });
  }
  const sessionDirectory = `${root}/account-session`;
  await mkdir(sessionDirectory);
  const sessionDriver = new AgenticDriver({
    providers: [
      codex({
        id: "session",
        binary: wrapper,
        accountDirectory: sessionDirectory,
        reasoningEffort,
      }),
    ],
  });
  assert.equal(
    (
      await codex({
        binary: wrapper,
        accountDirectory: sessionDirectory,
      }).inspect({ signal: watch() })
    ).code,
    "CLI_AUTH_REQUIRED",
  );
  cases.push({ name: "missing-native-session-discovery", status: "passed" });
  const jwt = (body) =>
    [{ alg: "none", typ: "JWT" }, body, "synthetic-signature"]
      .map((part) =>
        Buffer.from(
          typeof part === "string" ? part : JSON.stringify(part),
        ).toString("base64url"),
      )
      .join(".");
  for (const name of ["refresh", "expired", "reused", "invalidated"]) {
    scenario = `session-${name}`;
    const original = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "fixture-session-account",
            chatgpt_plan_type: "plus",
          },
        }),
        access_token: jwt({ exp: 1 }),
        refresh_token: "fixture-session-refresh",
        account_id: "fixture-session-account",
      },
      last_refresh: "2020-01-01T00:00:00Z",
    };
    sessionAccessToken = original.tokens.access_token;
    sessionIdToken = original.tokens.id_token;
    sessionRefreshedToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "fixture-session-account",
        chatgpt_plan_type: "plus",
      },
    });
    await writeFile(`${sessionDirectory}/auth.json`, JSON.stringify(original), {
      mode: 0o600,
    });
    const before = requests.length;
    const beforeRefresh = refreshRequests.length;
    const beforeExecutions = await executionCount();
    const call = sessionDriver.run(
      { provider: "session", model, input: "Supplied application context." },
      { signal: watch() },
    );
    if (name === "refresh") {
      assert.equal((await call).text, answer);
      assert.equal(requests.length - before, 1);
      const stored = JSON.parse(
        await readFile(`${sessionDirectory}/auth.json`, "utf8"),
      );
      assert.equal(stored.tokens.access_token, sessionRefreshedToken);
      assert.equal(stored.tokens.refresh_token, "fixture-session-rotated");
      assert.ok(
        Date.parse(stored.last_refresh) > Date.parse(original.last_refresh),
      );
    } else {
      await assert.rejects(call, (error) => {
        if (serverFailure) throw serverFailure;
        assert.equal(error.code, "CLI_AUTH_REQUIRED");
        assert.equal(error.retryable, false);
        assert.doesNotMatch(
          JSON.stringify(error),
          /PRIVATE_NATIVE_DIAGNOSTIC|fixture-session|127\.0\.0\.1/,
        );
        return true;
      });
      // Native managed-auth recovery retries the rejected Responses request
      // once after reloading auth; the SDK itself does not restart the run.
      assert.equal(requests.length - before, 2);
      const stored = JSON.parse(
        await readFile(`${sessionDirectory}/auth.json`, "utf8"),
      );
      assert.deepEqual(stored.tokens, original.tokens);
      assert.equal(stored.last_refresh, original.last_refresh);
    }
    if (serverFailure) throw serverFailure;
    assert.equal(
      (await executionCount()) - beforeExecutions,
      name === "refresh" ? 2 : 1,
    );
    const refreshAttempts = refreshRequests.length - beforeRefresh;
    assert.ok(refreshAttempts > 0 && refreshAttempts <= 10);
    cases.push({
      name: `managed-${scenario}`,
      status: "passed",
      refreshAttempts,
      modelRequests: requests.length - before,
      nativeExecutions: (await executionCount()) - beforeExecutions,
    });
  }
  for (const name of Object.keys(forbiddenCalls)) {
    scenario = `forbidden-${name}`;
    scenarioRequests = 0;
    selectedAccount = 0;
    const before = requests.length;
    let sdkRejected = false;
    try {
      await driver.run(request(), { signal: watch() });
    } catch (error) {
      assert.equal(
        error.code,
        "CLI_POLICY_VIOLATION",
        `${name}: ${error.code}`,
      );
      sdkRejected = true;
    }
    if (serverFailure) throw serverFailure;
    const toolOutputs = requests
      .slice(before)
      .flatMap((request) => request.input ?? [])
      .filter((item) =>
        ["function_call_output", "custom_tool_call_output"].includes(item.type),
      );
    if (!sdkRejected) {
      assert.equal(toolOutputs.length, 1, name);
      assert.match(
        JSON.stringify(toolOutputs[0].output),
        /unsupported call|unsupported custom tool|not a function|unsupported import in exec|not defined/i,
        JSON.stringify(toolOutputs[0]),
      );
    }
    assert.ok(
      !JSON.stringify(toolOutputs).includes("FORBIDDEN_CONTEXT_MARKER"),
    );
    assert.ok(!JSON.stringify(toolOutputs).includes("iVBORw0KGgo"));
    await assert.rejects(access(`${root}/forbidden-created`), {
      code: "ENOENT",
    });
    cases.push({
      name: `reject-native-${name}`,
      status: "passed",
      sdkRejected,
      nativeRejections: toolOutputs.map((item) => item.output),
    });
  }
  scenario = "registry";
  scenarioRequests = 0;
  const beforeRegistry = requests.length;
  await driver.run(request(), { signal: watch() });
  if (serverFailure) throw serverFailure;
  const registryOutput = requests
    .slice(beforeRegistry)
    .flatMap((request) => request.input ?? [])
    .find((item) => item.type === "custom_tool_call_output");
  assert.ok(registryOutput);
  const registryText = registryOutput.output
    .map((part) => part.text ?? "")
    .join("\n");
  assert.match(registryText, /"tools":\["clock__curr_time"\]/);
  for (const key of ["fetch", "process", "require", "Deno"])
    assert.ok(registryText.includes(`"${key}":"undefined"`));
  cases.push({
    name: "native-code-registry-has-only-clock-and-no-system-globals",
    status: "passed",
  });
  scenario = "cancel";
  const controller = new AbortController();
  cancel = () => controller.abort();
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const before = requests.length;
  await assert.rejects(
    driver.run(request(), {
      signal: AbortSignal.any([controller.signal, watch()]),
    }),
    { code: "CANCELLED" },
  );
  await Promise.race([
    closed,
    delay(5000, undefined, { ref: false }).then(() => {
      throw new Error("Cancellation did not close the native response stream.");
    }),
  ]);
  assert.equal(requests.length - before, 1);
  cases.push({ name: "cancellation-closes-native-stream", status: "passed" });

  for (const marker of ["hook-started", "mcp-started"])
    await assert.rejects(access(`${root}/${marker}`), { code: "ENOENT" });
  const pids = (await readFile(`${root}/native-pids.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).pid);
  const running = () =>
    pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return false;
      }
    });
  const bundleProcesses = async () => {
    const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const found = await Promise.all(
      pids.map(async (pid) => {
        try {
          const command = (
            await readFile(`/proc/${pid}/cmdline`, "utf8")
          ).split("\0")[0];
          return ["/tmp/fixture-codex", "/tmp/codex-code-mode-host"].includes(
            command,
          )
            ? Number(pid)
            : undefined;
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        }
      }),
    );
    return found.filter((pid) => pid !== undefined);
  };
  for (
    let attempt = 0;
    attempt < 100 && (running().length || (await bundleProcesses()).length);
    attempt++
  )
    await delay(20);
  assert.deepEqual(
    running(),
    [],
    "Native processes must be reaped after cancellation.",
  );
  assert.deepEqual(
    await bundleProcesses(),
    [],
    "Bundled native helpers must not survive their run.",
  );
  cases.push({
    name: "restricted-native-tools-hooks-and-mcp-processes",
    status: "passed",
  });
  cases.push({ name: "native-process-cleanup", status: "passed" });
  const content = JSON.stringify(requests[0]);
  console.log(
    JSON.stringify({
      version,
      model,
      reasoningEffort,
      effectiveToolCatalog: nativeTools(requests[0]),
      cases,
      ambientContextObserved: Object.fromEntries(
        Object.entries(markers).map(([name, marker]) => [
          name,
          content.includes(marker),
        ]),
      ),
      tokenStreaming: false,
    }),
  );
} catch (error) {
  console.error(
    "Native fixture diagnostics:",
    (await readFile(`${root}/native-stderr.txt`, "utf8").catch(() => "")).slice(
      -3000,
    ),
  );
  const wire = await readFile(`${root}/native-wire.jsonl`, "utf8");
  console.error(
    wire
      .split("\n")
      .filter((line) => {
        try {
          const x = JSON.parse(line);
          return x.error || x.method === "error";
        } catch {
          return false;
        }
      })
      .slice(-5)
      .join("\n"),
  );
  if (serverFailure) console.error("Fixture endpoint:", serverFailure);
  throw error;
} finally {
  activeResponse?.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
