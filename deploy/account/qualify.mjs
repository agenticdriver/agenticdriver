/** Real-account acceptance inside the deployed account container. Never returns credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  writeFile,
  access,
  readlink,
} from "node:fs/promises";
import { AgenticClient } from "/opt/agenticdriver/dist/client.js";

const config = JSON.parse(
  await readFile("/etc/agenticdriver/config.json", "utf8"),
);
const selected = config.providers[0];
const model = process.argv[3];
const mode = process.argv[2];
const client = new AgenticClient({
  url: "https://127.0.0.1:8443/",
  token: async () =>
    (await readFile(config.tokens[0].tokenRef.file, "utf8")).trim(),
});
const report = { mode, provider: selected.id, model };
if (mode === "catalog") {
  const providers = await client.providers({ refresh: true });
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider.id, selected.id);
  assert.equal(provider.connection?.account?.status, "signed-in");
  assert.equal(provider.modelCatalog?.source, "provider");
  assert.ok(provider.modelCatalog.models.includes(model));
  report.runtime = provider.connection.runtime;
  report.account = {
    status: provider.connection.account.status,
    subscription: provider.connection.account.subscription,
    hasIdentity: Boolean(
      provider.connection.account.email || provider.connection.account.name,
    ),
  };
  report.reportedModels = provider.modelCatalog.models;
} else if (mode === "run" || mode === "cancel") {
  const controller = new AbortController();
  const events = {};
  let text = "";
  let cancelledAfterProgress = false;
  const input =
    "Write a concise release handoff for AgenticDriver, an SDK for TypeScript, Python, Go and Rust applications. It connects explicitly selected Codex and Claude subscriptions through local or secured remote hosts. The Linux desktop manages providers and connections. Account-reported model availability is separate from live qualification. Python is available as reviewed GitHub archives while PyPI organization approval is pending. Summarize what app developers should validate before adopting a release candidate, including grounded source citations, saved settings, cancellation and recovery. Do not claim universal model support, send messages or use tools.";
  report.promptSha256 = createHash("sha256").update(input).digest("hex");
  try {
    for await (const event of client.stream(
      {
        provider: selected.id,
        model,
        input,
        maxSteps: 1,
        retry: { maxAttempts: 1 },
      },
      { signal: controller.signal },
    )) {
      events[event.type] = (events[event.type] ?? 0) + 1;
      if (event.type === "run.started") report.runId = event.runId;
      if (event.type === "text.delta") text += event.text;
      if (event.type === "usage.reported") report.usage = event.usage;
      if (event.type === "run.completed") {
        text = event.result.text;
        report.usage = event.result.usage;
      }
      if (event.type === "run.failed")
        throw new Error(`Run failed: ${event.error.code}`);
      if (mode === "cancel" && event.type === "run.progress") {
        cancelledAfterProgress = true;
        controller.abort();
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  report.events = events;
  if (mode === "run") {
    assert.equal(events["run.completed"], 1);
    assert.ok(text.trim().length > 80);
    report.response = text;
    report.responseSha256 = createHash("sha256").update(text).digest("hex");
  } else {
    assert.ok(cancelledAfterProgress);
    assert.equal(events["run.completed"], undefined);
    report.cancelledAfterProgress = true;
  }
} else if (mode === "probe") {
  assert.equal(process.getuid(), 1000);
  const status = await readFile("/proc/self/status", "utf8");
  assert.match(status, /NoNewPrivs:\s+1/);
  assert.match(status, /CapEff:\s+0+\n/);
  assert.match(status, /Seccomp:\s+2/);
  await assert.rejects(
    writeFile("/opt/agenticdriver/not-writable", "boundary"),
    { code: "EROFS" },
  );
  for (const path of [
    "/var/run/docker.sock",
    "/run/host",
    "/home/hashim",
    selected.kind === "codex"
      ? "/home/node/.claude/.credentials.json"
      : "/home/node/.codex/auth.json",
  ])
    await assert.rejects(access(path));
  const tmp = await readdir("/tmp");
  report.temporaryInvocationDirectories = tmp.filter((name) =>
    name.startsWith("agenticdriver-"),
  );
  assert.deepEqual(report.temporaryInvocationDirectories, []);
  const nativeProcesses = [];
  for (const pid of (await readdir("/proc")).filter((name) =>
    /^\d+$/.test(name),
  )) {
    const executable = await readlink(`/proc/${pid}/exe`).catch(() => "");
    if (/\/(codex|claude)$/.test(executable)) nativeProcesses.push(Number(pid));
  }
  assert.deepEqual(nativeProcesses, []);
  report.nativeProcessesRemaining = 0;
  report.nonRoot = true;
  report.readOnlyRoot = true;
  report.noNewPrivileges = true;
  report.noCapabilities = true;
  report.defaultSeccomp = true;
  report.siblingAccountAbsent = true;
} else throw new Error("Select catalog, run, cancel or probe.");
process.stdout.write(JSON.stringify(report) + "\n");
