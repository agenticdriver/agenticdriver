import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SqliteJobStore } from "../src/sqlite-job-store.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const options = { retentionMs: 60_000, maxJobs: 10, maxJobsPerSubject: 10 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "driver-cli-handoff-"));
  const config = join(root, "host.json");
  const path = join(root, "jobs.sqlite");
  const token = randomBytes(32).toString("hex");
  await writeFile(join(root, "token"), token, { mode: 0o600 });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      listen: { host: "127.0.0.1", port: 0 },
      providers: [],
      tokens: [
        {
          id: "operator",
          subject: "storage-test",
          providers: [],
          jobs: ["read"],
          tokenRef: { file: "token" },
        },
      ],
      jobs: { ...options, path: "jobs.sqlite" },
    }),
    { mode: 0o600 },
  );
  return {
    root,
    config,
    path,
    token,
    run: (...args: string[]) => run(config, args),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function run(config: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cli, ...args, "--config", config, "--json"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  let ready: (value: { url: string }) => void;
  let failed: (error: Error) => void;
  const listening = new Promise<{ url: string }>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // Most invocations are expected to exit without listening.
  void listening.catch(() => {});
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.stdout.setEncoding("utf8").on("data", (data) => {
    stdout += data;
  });
  child.stdout.on("data", () => {
    const line = stdout.split("\n")[0]!;
    if (stdout.includes("\n") && JSON.parse(line).event === "listening")
      ready(JSON.parse(line));
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(watchdog);
      failed(new Error(`CLI closed before listening: ${stderr}`));
      resolve({ code, stdout, stderr });
    });
  });
  return { child, done, listening };
}

test("CLI inspection observes the configured original queue without initializing missing storage", async () => {
  const f = await fixture();
  try {
    const missing = await f.run("inspect-jobs").done;
    assert.equal(missing.code, 1);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
    const store = await SqliteJobStore.open(f.path, options);
    await store.close();
    const before = await SqliteJobStore.inspect(f.path);
    const observed = await f.run("inspect-jobs").done;
    assert.equal(observed.code, 0, observed.stderr);
    assert.deepEqual(JSON.parse(observed.stdout), before);
    assert.deepEqual(await SqliteJobStore.inspect(f.path), before);
  } finally {
    await f.close();
  }
});

// Storage input only: no provider is registered and no successful model output is fabricated.
const storageJob = {
  subject: "storage-test",
  keyHash: "accepted-key",
  fingerprint: "accepted-fingerprint",
  principal: "storage-test",
  account: { hostId: "storage-test", accountId: "storage-test" },
  request: {
    provider: "not-dispatched",
    model: "not-dispatched",
    input: "Storage lifecycle only.",
  },
};

test("CLI serve adopts the inspected queue, fences stale handles and releases ownership on SIGTERM", async () => {
  const f = await fixture();
  const store = await SqliteJobStore.open(f.path, options);
  let host: ReturnType<typeof run> | undefined;
  try {
    const job = await store.submit(storageJob);
    await store.cancel(storageJob.subject, job.info.id);
    const originalConfig = await readFile(f.config, "utf8");
    const before = await SqliteJobStore.inspect(f.path);
    host = f.run("serve", "--handoff-snapshot", before.snapshot);
    const { url } = await host.listening;
    const health = await fetch(new URL("/health", url));
    assert.equal(health.status, 200);
    await assert.rejects(store.read(storageJob.subject, job.info.id), {
      code: "JOB_LEASE_LOST",
    });
    assert.equal((await SqliteJobStore.inspect(f.path)).lease, "active");
    host.child.kill("SIGTERM");
    const stopped = await host.done;
    assert.equal(stopped.code, 0, stopped.stderr);
    const after = await SqliteJobStore.inspect(f.path);
    assert.equal(after.lease, "none");
    assert.equal(after.quiet, true);
    assert.equal(after.acceptedKeys, 1);
    assert.deepEqual(after.states, before.states);
    const reopened = await SqliteJobStore.openExisting(f.path, options);
    const reader = await reopened.acquireQuiet(
      "storage-check",
      60_000,
      after.snapshot,
    );
    try {
      assert.equal(
        (await reader.read(storageJob.subject, job.info.id)).info.state,
        "cancelled",
      );
    } finally {
      await reader.release("storage-check");
      await reader.close();
    }
    await reopened.close();
    assert.equal(await readFile(f.config, "utf8"), originalConfig);
  } finally {
    host?.child.kill("SIGTERM");
    await host?.done;
    await store.close();
    await f.close();
  }
});

test("CLI handoff refuses changed or pending storage without dispatch or maintenance", async () => {
  const f = await fixture();
  const store = await SqliteJobStore.open(f.path, options);
  try {
    const empty = await SqliteJobStore.inspect(f.path);
    await store.submit(storageJob);
    const pending = await SqliteJobStore.inspect(f.path);
    for (const [snapshot, code] of [
      [empty.snapshot, "JOB_HANDOFF_CHANGED"],
      [pending.snapshot, "JOB_HANDOFF_BLOCKED"],
    ] as const) {
      const refused = await f.run("serve", "--handoff-snapshot", snapshot).done;
      assert.equal(refused.code, 1);
      assert.equal(refused.stdout, "");
      assert.equal(
        JSON.parse(refused.stderr.trim().split("\n").at(-1)!).error.code,
        code,
      );
      assert.deepEqual(await SqliteJobStore.inspect(f.path), pending);
    }
  } finally {
    await store.close();
    await f.close();
  }
});

test("CLI handoff rejects invalid options and missing storage instead of creating a substitute queue", async () => {
  const f = await fixture();
  try {
    const invalid = await f.run("serve", "--handoff-snapshot", "invalid").done;
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, "INVALID_ARGUMENT");
    const missing = await f.run("serve", "--handoff-snapshot", "0".repeat(64))
      .done;
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
    const config = JSON.parse(await readFile(f.config, "utf8"));
    delete config.jobs;
    await writeFile(f.config, JSON.stringify(config), { mode: 0o600 });
    for (const args of [
      ["inspect-jobs"],
      ["serve", "--handoff-snapshot", "0".repeat(64)],
    ]) {
      const disabled = await f.run(...args).done;
      assert.equal(disabled.code, 1);
      assert.equal(disabled.stdout, "");
      assert.equal(JSON.parse(disabled.stderr).error.code, "JOBS_DISABLED");
    }
    const ordinary = f.run("serve");
    try {
      await ordinary.listening;
    } finally {
      ordinary.child.kill("SIGTERM");
    }
    assert.equal((await ordinary.done).code, 0);
  } finally {
    await f.close();
  }
});
