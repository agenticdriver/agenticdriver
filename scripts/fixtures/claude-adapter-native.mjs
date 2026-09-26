/** Actual native CLI, production adapter, synthetic issuer; external networking is disabled by the runner. */
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { claudeCode } from "/tmp/fixture-sdk/dist/providers/index.js";

const root = "/tmp/fixture-work",
  account = `${root}/account`;
const model = "claude-haiku-4-5-20251001";
const marker = `${root}/ambient-executed`,
  sentinel = "UNTRUSTED_AMBIENT_MEMORY_FIXTURE";
assert.equal(
  execFileSync("/tmp/fixture-claude", ["--version"], {
    encoding: "utf8",
  }).trim(),
  "2.1.282 (Claude Code)",
);
await mkdir(account, { recursive: true });
await writeFile(
  `${account}/.credentials.json`,
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "synthetic-native-token-never-valid",
      refreshToken: "synthetic-native-refresh-never-valid",
      expiresAt: Date.now() + 86_400_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    },
  }),
  { mode: 0o600 },
);
const settings = {
  hooks: Object.fromEntries(
    ["SessionStart", "SessionEnd", "PreToolUse", "Stop"].map((name) => [
      name,
      [{ hooks: [{ type: "command", command: `touch ${marker}` }] }],
    ]),
  ),
  fallbackModel: ["other-fixture-model"],
  switchModelsOnFlag: true,
};
const mcp = {
  mcpServers: { ambient: { command: "/usr/bin/touch", args: [marker] } },
};
await writeFile(`${account}/settings.json`, JSON.stringify(settings));
await writeFile(`${account}/.claude.json`, JSON.stringify(mcp));
await writeFile(`${account}/CLAUDE.md`, sentinel);

let mode = "success";
const requests = [],
  otherPaths = new Set();
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!request.url.startsWith("/v1/messages")) {
    otherPaths.add(request.url.split("?")[0]);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { type: "not_found_error", message: "Synthetic endpoint" },
      }),
    );
    return;
  }
  const body = JSON.parse(raw),
    entry = {
      mode,
      model: body.model,
      tools: body.tools?.length ?? 0,
      ambientMemory: raw.includes(sentinel),
      closed: false,
    };
  requests.push(entry);
  response.once("close", () => {
    entry.closed = true;
  });
  if (mode === "reject") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "not_found_error",
          message: "synthetic-private-diagnostic",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (value) =>
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 25,
        output_tokens: 0,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 2,
      },
    },
  });
  if (mode === "tool") {
    event({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool_fixture",
        name: "Bash",
        input: {},
      },
    });
    event({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ command: `touch ${marker}` }),
      },
    });
    event({ type: "content_block_stop", index: 0 });
    event({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    });
    event({ type: "message_stop" });
    response.end();
    return;
  }
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "native " },
  });
  if (mode === "cancel") return; // Keep stream open until the SDK cancels its owned native process.
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "fixture" },
  });
  event({ type: "content_block_stop", index: 0 });
  event({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  event({ type: "message_stop" });
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const wrapper = `${root}/claude-wrapper`;
// Only this offline harness overrides the endpoint. Production strips ANTHROPIC_BASE_URL.
await writeFile(
  wrapper,
  `#!/tmp/fixture-node
import {spawn} from "node:child_process";
import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2),cwd=process.cwd();
if(args.includes("--print")) {
  mkdirSync(cwd+"/.claude",{recursive:true});
  writeFileSync(cwd+"/.claude/settings.json",${JSON.stringify(JSON.stringify(settings))});
  writeFileSync(cwd+"/.mcp.json",${JSON.stringify(JSON.stringify(mcp))});
  writeFileSync(cwd+"/CLAUDE.md",${JSON.stringify(sentinel)});
}
const child=spawn("/tmp/fixture-claude",args,{env:{...process.env,ANTHROPIC_BASE_URL:"http://127.0.0.1:${server.address().port}"},stdio:"inherit"});
appendFileSync(${JSON.stringify(root + "/invocations.jsonl")},JSON.stringify({args,cwd,pid:process.pid,nativePid:child.pid})+"\\n");
child.on("error",()=>{process.exitCode=1});child.on("exit",code=>{process.exitCode=code??1});
`,
  { mode: 0o700 },
);
const adapter = claudeCode({ binary: wrapper, accountDirectory: account });
const invoke = (context) =>
  adapter.complete(
    {
      model,
      messages: [{ role: "user", content: "Synthetic fixture input" }],
      tools: [],
    },
    context,
  );
const watchdog = () => AbortSignal.timeout(20000); // Offline test watchdog only.
try {
  const deltas = [];
  const result = await invoke({
    signal: watchdog(),
    emitText: (text) => deltas.push(text),
    reportProgress() {},
  });
  assert.equal(result.text, "native fixture");
  assert.equal(deltas.join(""), result.text);
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.cachedInputTokens, 2);
  assert.equal(typeof result.usage.apiEquivalentCostUsd, "number");
  assert.equal(result.usage.costUsd, undefined);
  assert.equal(requests.length, 1, JSON.stringify(requests));
  mode = "cancel";
  const cancel = new AbortController(),
    cancelledText = [];
  await assert.rejects(
    invoke({
      signal: AbortSignal.any([cancel.signal, watchdog()]),
      emitText: (text) => {
        cancelledText.push(text);
        cancel.abort();
      },
      reportProgress() {},
    }),
    { code: "CANCELLED" },
  );
  assert.ok(cancelledText.join("").includes("native"));
  for (
    let i = 0;
    i < 100 && !requests.find((r) => r.mode === "cancel")?.closed;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.find((r) => r.mode === "cancel").closed, true);
  mode = "reject";
  await assert.rejects(
    invoke({ signal: watchdog(), emitText() {}, reportProgress() {} }),
    (error) =>
      error.code === "CLI_FAILED" &&
      !error.message.includes("synthetic-private-diagnostic"),
  );
  assert.ok(
    requests.filter((r) => r.mode === "reject").length >= 1 &&
      requests.filter((r) => r.mode === "reject").length <= 2,
    JSON.stringify(requests),
  );
  mode = "tool";
  await assert.rejects(
    invoke({ signal: watchdog(), emitText() {}, reportProgress() {} }),
    { code: "CLI_POLICY_VIOLATION" },
  );
  await assert.rejects(access(marker));
  assert.ok(
    requests.every(
      (r) => r.model === model && r.tools === 0 && !r.ambientMemory,
    ),
  );
  const invocations = (await readFile(`${root}/invocations.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  for (const entry of invocations.filter((e) => e.args.includes("--print"))) {
    for (const flag of [
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ])
      assert.ok(entry.args.includes(flag));
    assert.equal(entry.args[entry.args.indexOf("--tools") + 1], "");
    assert.equal(entry.args[entry.args.indexOf("--model") + 1], model);
    await assert.rejects(access(entry.cwd));
    for (const pid of [entry.pid, entry.nativePid]) {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
        () => null,
      );
      assert.ok(
        state === null ||
          state.slice(state.lastIndexOf(")") + 2).startsWith("Z "),
      );
    }
  }
  const persisted = [];
  async function scan(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      if (e.isDirectory()) await scan(`${path}/${e.name}`);
      else if (e.name.endsWith(".jsonl")) persisted.push(e.name);
    }
  }
  await scan(account);
  assert.deepEqual(persisted, []);
  console.log(
    JSON.stringify({
      passed: true,
      nativeVersion: "2.1.282",
      realCredentials: false,
      externalNetwork: false,
      cases: [
        "streaming-no-duplicate-text",
        "normalized-cli-estimate",
        "cancellation-reaps-native-process",
        "model-refusal-no-fallback",
        "unsolicited-tool-rejected",
        "ambient-hooks-mcp-memory-blocked",
        "no-session-persistence",
      ],
      model,
      modelRequests: requests.length,
      liveInferenceRequests: 0,
      otherPaths: [...otherPaths],
      fixtureSeam:
        "Only the isolated test wrapper selects a loopback endpoint; no live issuer or account qualification.",
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
