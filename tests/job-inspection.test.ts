import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  readdir,
  chmod,
  link,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteJobStore } from "../src/sqlite-job-store.js";

const options = { retentionMs: 1_000, maxJobs: 10, maxJobsPerSubject: 10 };
// A public storage input only; there is no provider, account connection or model execution.
const input = {
  subject: "storage-test",
  keyHash: "accepted-key",
  fingerprint: "request-fingerprint",
  principal: "storage-test",
  account: { hostId: "storage-test", accountId: "storage-test" },
  request: {
    provider: "not-dispatched",
    model: "not-dispatched",
    input: "Storage transition only.",
  },
};
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      jobs: db.prepare("SELECT * FROM ad_jobs ORDER BY id").all(),
      leases: db.prepare("SELECT * FROM ad_job_worker ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

test("inspection leaves expired ownership and running records unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-inspection-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  try {
    await store.acquire("original", 60_000);
    const job = await store.submit(input);
    await store.start("original", job.info.id);
    await store.renew("original", 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const before = rows(path);
    const report = await SqliteJobStore.inspect(path);
    assert.deepEqual(report.states, { running: 1 });
    assert.equal(report.lease, "expired");
    assert.equal(report.acceptedKeys, 1);
    assert.equal(report.quiet, false);
    assert.deepEqual(rows(path), before);
    assert.equal(
      (await SqliteJobStore.inspect(path)).snapshot,
      report.snapshot,
    );
    assert.ok(!JSON.stringify(report).includes(input.keyHash));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection never initializes a missing or empty database", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-missing-"));
  try {
    const missing = join(root, "missing.sqlite");
    await assert.rejects(SqliteJobStore.inspect(missing), { code: "ENOENT" });
    await assert.rejects(stat(missing), { code: "ENOENT" });
    const empty = join(root, "empty.sqlite");
    await writeFile(empty, "", { mode: 0o600 });
    await assert.rejects(SqliteJobStore.inspect(empty), {
      code: "JOB_STORAGE_MISMATCH",
    });
    assert.equal((await stat(empty)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection preserves expired payloads and treats erased outcomes as unclassified", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-retention-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  try {
    const job = await store.submit(input);
    assert.deepEqual((await SqliteJobStore.inspect(path)).blockers, [
      "pending",
    ]);
    await store.cancel(input.subject, job.info.id);
    const cancelled = await SqliteJobStore.inspect(path);
    assert.equal(cancelled.quiet, true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const before = rows(path);
    assert.equal(
      (await SqliteJobStore.inspect(path)).snapshot,
      cancelled.snapshot,
    );
    assert.deepEqual(rows(path), before);
    await assert.rejects(store.read(input.subject, job.info.id), {
      code: "JOB_EXPIRED",
    });
    const retained = await SqliteJobStore.inspect(path);
    assert.equal(retained.acceptedKeys, 1);
    assert.deepEqual(retained.states, { cancelled: 1 });
    assert.deepEqual(retained.blockers, ["unclassified"]);
    assert.equal(retained.quiet, false);
    assert.notEqual(retained.snapshot, cancelled.snapshot);
    await assert.rejects(store.submit(input), { code: "JOB_EXPIRED" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal cancellation does not conceal recorded uncertain effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-uncertain-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  try {
    await store.acquire("worker", 60_000);
    const job = await store.submit(input);
    await store.start("worker", job.info.id);
    await store.append("worker", job.info.id, {
      type: "run.started",
      runId: job.info.runId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      provider: input.request.provider,
      model: input.request.model,
    });
    // An authored failure record exercises storage classification, never a successful model result.
    await store.append("worker", job.info.id, {
      type: "run.cancelled",
      runId: job.info.runId,
      sequence: 2,
      timestamp: new Date().toISOString(),
      error: {
        code: "EFFECT_UNKNOWN",
        message: "Reconcile effects.",
        retryable: false,
        outcome: "uncertain",
      },
    });
    await store.release("worker");
    const before = rows(path);
    const report = await SqliteJobStore.inspect(path);
    assert.deepEqual(report.states, { cancelled: 1 });
    assert.deepEqual(report.blockers, ["unreconciled"]);
    assert.equal(report.quiet, false);
    assert.deepEqual(rows(path), before);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot identity distinguishes independent stores with identical contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-identity-"));
  const first = await SqliteJobStore.open(join(root, "first.sqlite"), options);
  const second = await SqliteJobStore.open(
    join(root, "second.sqlite"),
    options,
  );
  try {
    const a = await SqliteJobStore.inspect(join(root, "first.sqlite"));
    const b = await SqliteJobStore.inspect(join(root, "second.sqlite"));
    assert.equal(a.quiet, true);
    assert.equal(b.quiet, true);
    assert.deepEqual(a.states, b.states);
    assert.notEqual(a.snapshot, b.snapshot);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closed-store inspection preserves database bytes while allowing SQLite WAL bookkeeping", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-closed-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  try {
    const job = await store.submit(input);
    await store.cancel(input.subject, job.info.id);
    await store.close();
    const before = await readFile(path);
    assert.deepEqual(await readdir(root), ["jobs.sqlite"]);
    const report = await SqliteJobStore.inspect(path);
    assert.deepEqual(report.states, { cancelled: 1 });
    assert.equal(report.quiet, true);
    assert.deepEqual(await readFile(path), before);
    for (const name of await readdir(root)) {
      assert.ok(
        ["jobs.sqlite", "jobs.sqlite-wal", "jobs.sqlite-shm"].includes(name),
      );
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "job database validation rejects unsafe existing files without changing the original",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-job-file-boundary-"));
    const path = join(root, "jobs.sqlite");
    const store = await SqliteJobStore.open(path, options);
    await store.close();
    const original = await readFile(path);
    async function refuses(candidate: string) {
      await assert.rejects(SqliteJobStore.inspect(candidate), {
        code: "JOB_STORAGE_UNSAFE",
      });
      await assert.rejects(SqliteJobStore.openExisting(candidate, options), {
        code: "JOB_STORAGE_UNSAFE",
      });
      await assert.rejects(SqliteJobStore.open(candidate, options), {
        code: "JOB_STORAGE_UNSAFE",
      });
      assert.deepEqual(await readFile(path), original);
    }
    try {
      await chmod(path, 0o644);
      await refuses(path);
      await chmod(path, 0o600);
      const alias = join(root, "alias.sqlite");
      await symlink(path, alias);
      await refuses(alias);
      await rm(alias);
      await link(path, alias);
      await refuses(alias);
      await rm(alias);
      const reopened = await SqliteJobStore.openExisting(path, options);
      await reopened.close();
      assert.equal((await SqliteJobStore.inspect(path)).quiet, true);
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.startsWith(".job-create-")),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
