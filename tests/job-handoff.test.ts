import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteJobStore } from "../src/sqlite-job-store.js";

const options = { retentionMs: 60_000, maxJobs: 10, maxJobsPerSubject: 10 };
// Storage input only: no provider connection or model result is installed.
const input = {
  subject: "storage-test",
  keyHash: "retained-key",
  fingerprint: "request-fingerprint",
  principal: "storage-test",
  account: { hostId: "storage-test", accountId: "storage-test" },
  request: {
    provider: "not-dispatched",
    model: "not-dispatched",
    input: "Storage lifecycle only.",
  },
};

test("conditional acquisition preserves prior accepted work and returns a distinct lease-bound handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  let bound: SqliteJobStore | undefined;
  try {
    const job = await store.submit(input);
    const before = await store.cancel(input.subject, job.info.id);
    const observation = await SqliteJobStore.inspect(path);
    bound = await store.acquireQuiet("owner", 60_000, observation.snapshot);
    await assert.rejects(store.submit(input), { code: "JOB_LEASE_LOST" });
    assert.deepEqual(await bound.read(input.subject, job.info.id), before);
    assert.deepEqual(await bound.queued("owner"), []);
    assert.equal((await SqliteJobStore.inspect(path)).lease, "active");
    await bound.release("owner");
    await assert.rejects(bound.submit({ ...input, keyHash: "after-release" }), {
      code: "JOB_LEASE_LOST",
    });
  } finally {
    await bound?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("changed snapshot refusal preserves expired payloads without migration or recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-change-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, {
    ...options,
    retentionMs: 1_000,
  });
  try {
    const first = await store.submit(input);
    await store.cancel(input.subject, first.info.id);
    const observed = await SqliteJobStore.inspect(path);
    await store.submit({ ...input, keyHash: "arrived-after-inspection" });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const before = await SqliteJobStore.inspect(path);
    await assert.rejects(
      store.acquireQuiet("replacement", 60_000, observed.snapshot),
      { code: "JOB_HANDOFF_CHANGED" },
    );
    assert.deepEqual(await SqliteJobStore.inspect(path), before);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const state of [
  "queued",
  "active-lease",
  "expired-lease",
  "interrupted",
] as const) {
  test(`quiet acquisition refuses ${state} without retention, recovery or schema changes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-blocked-"));
    const path = join(root, "jobs.sqlite");
    const store = await SqliteJobStore.open(path, options);
    try {
      const job = await store.submit(input);
      if (state !== "queued") {
        await store.acquire("old", 60_000);
        await store.start("old", job.info.id);
        if (state === "expired-lease") {
          await store.renew("old", 1);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (state === "interrupted") await store.release("old");
      }
      const before = await SqliteJobStore.inspect(path);
      await assert.rejects(store.acquireQuiet("new", 60_000, before.snapshot), {
        code: "JOB_HANDOFF_BLOCKED",
      });
      assert.deepEqual(await SqliteJobStore.inspect(path), before);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("competing acquisitions have one winner and stale handles cannot write after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-race-"));
  const path = join(root, "jobs.sqlite");
  const first = await SqliteJobStore.open(path, options);
  const second = await SqliteJobStore.open(path, options);
  let bound: SqliteJobStore | undefined;
  try {
    const observed = await SqliteJobStore.inspect(path);
    const attempts = await Promise.allSettled([
      first.acquireQuiet("one", 60_000, observed.snapshot),
      second.acquireQuiet("two", 60_000, observed.snapshot),
    ]);
    const winners = attempts.filter((result) => result.status === "fulfilled");
    assert.equal(winners.length, 1);
    bound = (winners[0] as PromiseFulfilledResult<SqliteJobStore>).value;
    const owner = attempts[0]?.status === "fulfilled" ? "one" : "two";
    const job = await bound.submit(input);
    await bound.cancel(input.subject, job.info.id);
    const active = await SqliteJobStore.inspect(path);
    for (const stale of [first, second]) {
      for (const action of [
        () => stale.submit({ ...input, keyHash: "stale-submit" }),
        () => stale.read(input.subject, job.info.id),
        () => stale.cancel(input.subject, job.info.id),
        () => stale.renew(owner, 60_000),
        () => stale.release(owner),
        () => stale.queued(owner),
        () => stale.start(owner, job.info.id),
        () =>
          stale.fail(owner, job.info.id, {
            code: "REJECTED",
            message: "Stale handle.",
            retryable: false,
          }),
      ])
        await assert.rejects(action(), { code: "JOB_LEASE_LOST" });
    }
    assert.deepEqual(await SqliteJobStore.inspect(path), active);
    await bound.release(owner);
    const released = await SqliteJobStore.inspect(path);
    assert.equal(released.quiet, true);
    assert.notEqual(released.snapshot, observed.snapshot);
    await assert.rejects(
      bound.submit({ ...input, keyHash: "released-submit" }),
      { code: "JOB_LEASE_LOST" },
    );
    await assert.rejects(bound.acquire("rebind", 60_000), {
      code: "JOB_LEASE_LOST",
    });
    assert.deepEqual(await SqliteJobStore.inspect(path), released);
  } finally {
    await bound?.close();
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adopted stores retain eligibility and accepted keys through expiry and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-retention-"));
  const path = join(root, "jobs.sqlite");
  const original = await SqliteJobStore.open(path, {
    ...options,
    retentionMs: 1_000,
  });
  let bound: SqliteJobStore | undefined;
  let reopened: SqliteJobStore | undefined;
  let replacement: SqliteJobStore | undefined;
  try {
    const observed = await SqliteJobStore.inspect(path);
    bound = await original.acquireQuiet("owner", 60_000, observed.snapshot);
    const job = await bound.submit(input);
    await bound.cancel(input.subject, job.info.id);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await assert.rejects(bound.read(input.subject, job.info.id), {
      code: "JOB_EXPIRED",
    });
    await bound.release("owner");
    const retained = await SqliteJobStore.inspect(path);
    assert.equal(retained.quiet, true);
    assert.deepEqual(retained.blockers, []);
    assert.equal(retained.acceptedKeys, 1);
    reopened = await SqliteJobStore.open(path, options);
    replacement = await reopened.acquireQuiet(
      "replacement",
      60_000,
      retained.snapshot,
    );
    await assert.rejects(replacement.submit(input), { code: "JOB_EXPIRED" });
    const beforeStale = await SqliteJobStore.inspect(path);
    await assert.rejects(bound.release("owner"), { code: "JOB_LEASE_LOST" });
    assert.deepEqual(await SqliteJobStore.inspect(path), beforeStale);
    await replacement.release("replacement");
    assert.equal((await SqliteJobStore.inspect(path)).acceptedKeys, 1);
  } finally {
    await replacement?.close();
    await reopened?.close();
    await bound?.close();
    await original.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected competing ordinary worker cannot run the active owner's retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-busy-"));
  const path = join(root, "jobs.sqlite");
  const original = await SqliteJobStore.open(path, {
    ...options,
    retentionMs: 1_000,
  });
  let bound: SqliteJobStore | undefined;
  let competing: SqliteJobStore | undefined;
  try {
    bound = await original.acquireQuiet(
      "owner",
      60_000,
      (await SqliteJobStore.inspect(path)).snapshot,
    );
    const job = await bound.submit(input);
    await bound.cancel(input.subject, job.info.id);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    competing = await SqliteJobStore.open(path, options);
    const before = await SqliteJobStore.inspect(path);
    await assert.rejects(competing.acquire("competing", 60_000), {
      code: "JOB_WORKER_BUSY",
    });
    assert.deepEqual(await SqliteJobStore.inspect(path), before);
  } finally {
    await competing?.close();
    await bound?.close();
    await original.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "separate processes competing from one observation acquire exactly one owner",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-process-"));
    const path = join(root, "jobs.sqlite");
    const store = await SqliteJobStore.open(path, options);
    const children: ChildProcess[] = [];
    try {
      await store.close();
      const observed = await SqliteJobStore.inspect(path);
      for (const owner of ["child-one", "child-two"])
        children.push(
          fork(
            fileURLToPath(new URL("./job-handoff-child.ts", import.meta.url)),
            [path, observed.snapshot, owner],
            {
              execArgv: ["--import", "tsx"],
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            },
          ),
        );
      const ready = await Promise.all(
        children.map((child) =>
          once(child, "message", { signal: context.signal }),
        ),
      );
      assert.deepEqual(
        ready.map(([reply]) => reply.phase),
        ["ready", "ready"],
      );
      const outcomes = children.map((child) =>
        once(child, "message", { signal: context.signal }),
      );
      for (const child of children) child.send("acquire");
      const results = await Promise.all(outcomes);
      assert.deepEqual(results.map(([reply]) => reply.phase).sort(), [
        "accepted",
        "refused",
      ]);
      assert.equal((await SqliteJobStore.inspect(path)).lease, "active");
      const winner =
        children[results.findIndex(([reply]) => reply.phase === "accepted")]!;
      const released = once(winner, "message", { signal: context.signal });
      winner.send("release");
      assert.equal((await released)[0].phase, "released");
      assert.equal((await SqliteJobStore.inspect(path)).quiet, true);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const stopped = once(child, "exit");
          child.kill("SIGTERM");
          await stopped;
        }),
      );
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("initial v1 adoption compares current state; v2 ownership cycles invalidate observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-job-handoff-aba-"));
  const path = join(root, "jobs.sqlite");
  const legacy = await SqliteJobStore.open(path, options);
  let bound: SqliteJobStore | undefined;
  let cycle: SqliteJobStore | undefined;
  let next: SqliteJobStore | undefined;
  try {
    const initial = await SqliteJobStore.inspect(path);
    await legacy.acquire("legacy-cycle", 60_000);
    await legacy.release("legacy-cycle");
    assert.equal(
      (await SqliteJobStore.inspect(path)).snapshot,
      initial.snapshot,
    );
    bound = await legacy.acquireQuiet("adopt", 60_000, initial.snapshot);
    await assert.rejects(legacy.submit(input), { code: "JOB_LEASE_LOST" });
    await bound.release("adopt");
    const beforeCycle = await SqliteJobStore.inspect(path);
    cycle = await SqliteJobStore.openExisting(path, options);
    await cycle.acquire("cycle", 60_000);
    await cycle.release("cycle");
    const afterCycle = await SqliteJobStore.inspect(path);
    assert.notEqual(afterCycle.snapshot, beforeCycle.snapshot);
    next = await SqliteJobStore.openExisting(path, options);
    await assert.rejects(
      next.acquireQuiet("next", 60_000, beforeCycle.snapshot),
      { code: "JOB_HANDOFF_CHANGED" },
    );
    assert.deepEqual(await SqliteJobStore.inspect(path), afterCycle);
  } finally {
    await next?.close();
    await cycle?.close();
    await bound?.close();
    await legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});
