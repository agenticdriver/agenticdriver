// Launched only by test-codex-native.py in a fresh filesystem/network namespace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
const requests = [];
const cases = [];
let serverFailure;

const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const data of req) raw += data;
    assert.equal(req.url, "/v1/responses");
    assert.equal(
      req.headers.authorization,
      `Bearer fixture-account-${selectedAccount}`,
    );
    const body = JSON.parse(raw);
    requests.push(body);
    assert.equal(body.model, model);
    assert.equal(body.reasoning?.effort, reasoningEffort);
    assert.deepEqual(body.tools ?? [], []);
    const content = JSON.stringify(body);
    assert.ok(content.includes("Supplied application context."));
    assert.ok(!content.includes(markers.userConfiguration));
    assert.ok(!content.includes(markers.parentInstructions));
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
    const item = {
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
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
      },
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
// The wrapper adds only fixture endpoint/credential-store/telemetry settings.
// All execution-policy flags come from the actual SDK adapter under test.
const wrapper = `${root}/codex-fixture`;
await writeFile(
  wrapper,
  `#!/tmp/fixture-node
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
const extra=${JSON.stringify(overrides)}.flatMap(value=>['--config',value]);
const child=spawn('/tmp/fixture-codex',[...args,...extra],{stdio:'pipe',env:process.env});
fs.appendFileSync('${root}/native-pids.jsonl',JSON.stringify({pid:child.pid})+'\\n');
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
    assert.equal(terminal.type, "run.completed");
    assert.equal(terminal.result.text, answer);
    assert.deepEqual(terminal.result.usage, {
      inputTokens: 11,
      outputTokens: 5,
      cachedInputTokens: 0,
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
  for (let attempt = 0; attempt < 100 && running().length; attempt++)
    await delay(20);
  assert.deepEqual(
    running(),
    [],
    "Native processes must be reaped after cancellation.",
  );
  cases.push({
    name: "no-advertised-tools-hooks-or-mcp-processes",
    status: "passed",
  });
  cases.push({ name: "native-process-cleanup", status: "passed" });
  const content = JSON.stringify(requests[0]);
  console.log(
    JSON.stringify({
      version,
      model,
      reasoningEffort,
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
} finally {
  activeResponse?.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
