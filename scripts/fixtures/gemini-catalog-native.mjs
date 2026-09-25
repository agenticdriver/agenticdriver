import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";

// Protocol qualification only. This does not enable the SDK's Gemini catalog.
const root = "/tmp/fixture-work";
const marker = `${root}/ambient-executed`;
const settings = `${root}/system-settings.json`;
const policy = `${root}/deny-tools.toml`;
await writeFile(
  settings,
  JSON.stringify({
    tools: {
      core: ["__agenticdriver_no_tools__"],
      discoveryCommand: "",
      callCommand: "",
    },
    hooksConfig: { enabled: false },
    experimental: {
      enableAgents: false,
      autoMemory: false,
      modelSteering: false,
      gemmaModelRouter: { enabled: false },
    },
    skills: { enabled: false },
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
    telemetry: { enabled: false },
    ide: { enabled: false },
  }),
  { mode: 0o600 },
);
await writeFile(
  policy,
  '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
  { mode: 0o600 },
);

async function probe(mode) {
  const account = `${root}/${mode}`;
  const cwd = `${root}/workspace-${mode}`;
  await mkdir(`${account}/.gemini`, { recursive: true });
  await mkdir(cwd);
  await writeFile(
    `${account}/.gemini/settings.json`,
    JSON.stringify({
      security: {
        auth: {
          selectedType:
            mode === "api-fixture" ? "gemini-api-key" : "oauth-personal",
        },
      },
      hooksConfig: { enabled: true },
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: `touch ${marker}` }],
          },
        ],
      },
      mcpServers: { ambient: { command: "/usr/bin/touch", args: [marker] } },
      experimental: {
        autoMemory: true,
        gemmaModelRouter: { enabled: true, autoStartServer: true },
      },
    }),
    { mode: 0o600 },
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/tmp/fixture-node",
      [
        "/tmp/fixture-gemini/bundle/gemini.js",
        "--acp",
        "--extensions",
        "none",
        "--admin-policy",
        policy,
        "--approval-mode",
        "default",
      ],
      {
        cwd,
        detached: true,
        stdio: "pipe",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          GEMINI_CLI_HOME: account,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
          NO_BROWSER: "1",
          ...(mode === "api-fixture"
            ? { GEMINI_API_KEY: "synthetic-never-valid-catalog-fixture" }
            : {}),
        },
      },
    );
    let bytes = 0,
      pending = "",
      models,
      failure,
      authorizationPrompt = false;
    let requests = 0,
      initialized = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const fail = (error) => {
      failure = error;
      kill("SIGTERM");
    };
    // Test housekeeping only: no inference is submitted or given a deadline.
    const timer = setTimeout(
      () => fail(new Error("Native fixture watchdog expired.")),
      20_000,
    );
    const send = (id, method, params) => {
      requests++;
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    };
    const bound = (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000)
        fail(new Error("Native fixture output limit exceeded."));
    };
    child.stdout.on("data", (chunk) => {
      bound(chunk);
      if (failure) return;
      pending += chunk.toString("utf8");
      if (mode === "missing-oauth") {
        if (
          /authorize the application|Enter the authorization code/.test(pending)
        ) {
          authorizationPrompt = true;
          kill("SIGTERM");
        }
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop();
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          assert.equal(event.jsonrpc, "2.0");
          if (event.method === "session/update" && event.id === undefined) {
            assert.equal(
              event.params.update.sessionUpdate,
              "available_commands_update",
            );
            continue;
          }
          assert.equal(event.error, undefined);
          assert.equal(
            event.method,
            undefined,
            "No native authority request is accepted.",
          );
          if (event.id === 1) {
            assert.equal(initialized, false);
            assert.equal(event.result.protocolVersion, 1);
            assert.equal(event.result.agentInfo.version, "0.58.0");
            initialized = true;
            send(2, "session/new", { cwd, mcpServers: [] });
          } else {
            assert.equal(event.id, 2);
            assert.equal(initialized, true);
            assert.equal(models, undefined);
            const rows = event.result.models.availableModels;
            assert.ok(
              Array.isArray(rows) && rows.length > 0 && rows.length <= 1000,
            );
            for (const row of rows)
              assert.match(
                row.modelId,
                /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/,
              );
            models = [...new Set(rows.map((row) => row.modelId))];
            child.stdin.end();
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", bound);
    child.stdin.on("error", () => {});
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      kill("SIGKILL");
      try {
        if (failure) throw failure;
        if (mode === "api-fixture") {
          assert.equal(code, 0);
          assert.ok(models);
          assert.equal(requests, 2);
        } else {
          assert.equal(authorizationPrompt, true);
          assert.equal(requests, 0);
        }
        resolve({ models, requests, authorizationPrompt });
      } catch (error) {
        reject(error);
      }
    });
    if (mode === "api-fixture")
      send(1, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "agenticdriver-metadata-fixture",
          version: "0.1.0",
        },
      });
    // Missing OAuth deliberately receives no protocol input, so its auth UI cannot
    // consume an initialize request as an authorization code.
  });
}

const api = await probe("api-fixture");
const missing = await probe("missing-oauth");
await assert.rejects(access(marker));
console.log(
  JSON.stringify({
    nativeVersion: "0.58.0",
    passed: true,
    promptSubmitted: false,
    realCredentials: false,
    externalNetwork: false,
    apiFixtureModels: api.models,
    apiProtocolRequests: api.requests,
    ambientHooksAndMcpStarted: false,
    missingOAuthProtocolRequests: missing.requests,
    authorizationUiStartedBeforeProtocolInput: missing.authorizationPrompt,
    subscriptionCatalogProbeQualified: false,
    limitation:
      "ACP enters interactive OAuth before accepting protocol requests when no login is saved.",
  }),
);
