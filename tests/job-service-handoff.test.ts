import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgenticDriver } from "../src/driver.js";
import { JobService, type JobStore, type JobPrincipal } from "../src/jobs.js";
import { SqliteJobStore } from "../src/sqlite-job-store.js";
import { configuredServer, validateHostConfig } from "../src/host.js";
import { serve } from "../src/server.js";

const options = { retentionMs: 60_000, maxJobs: 10, maxJobsPerSubject: 10 };
const principal: JobPrincipal = {
  subject: "storage-test",
  providers: ["not-dispatched"],
  jobs: ["submit", "read", "cancel"],
};
// Historical storage metadata; the actual driver below is empty and cannot execute it.
const input = {
  subject: principal.subject,
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "driver-job-service-handoff-"));
  const path = join(root, "jobs.sqlite");
  const store = await SqliteJobStore.open(path, options);
  const driver = new AgenticDriver({ providers: [] });
  return {
    root,
    path,
    store,
    driver,
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("service conditionally opens the same queue and releases its acquired handle on close", async () => {
  const f = await fixture();
  let service: JobService | undefined;
  try {
    const job = await f.store.submit(input);
    const cancelled = await f.store.cancel(principal.subject, job.info.id);
    const observation = await SqliteJobStore.inspect(f.path);
    service = await JobService.open(f.driver, {
      store: f.store,
      handoff: { snapshot: observation.snapshot },
      resolvePrincipal: () => principal,
    });
    assert.deepEqual(f.driver.listProviders(), []);
    assert.deepEqual(
      await service.read({ id: job.info.id }, "storage-test"),
      cancelled.info,
    );
    await assert.rejects(f.store.read(principal.subject, job.info.id), {
      code: "JOB_LEASE_LOST",
    });
    await service.close();
    const closed = await SqliteJobStore.inspect(f.path);
    assert.equal(closed.lease, "none");
    assert.equal(closed.acceptedKeys, 1);
    assert.equal(closed.quiet, true);
  } finally {
    await service?.close();
    await f.close();
  }
});

test("selected handoff never falls back to ordinary acquisition when capability is absent", async () => {
  const f = await fixture();
  try {
    // Mask only the optional capability on the actual store; no substitute job engine/provider.
    const store: JobStore = f.store;
    store.acquireQuiet = undefined;
    const before = await SqliteJobStore.inspect(f.path);
    await assert.rejects(
      JobService.open(f.driver, {
        store,
        handoff: { snapshot: before.snapshot },
        resolvePrincipal: () => principal,
      }),
      { code: "JOB_HANDOFF_UNSUPPORTED" },
    );
    assert.deepEqual(await SqliteJobStore.inspect(f.path), before);
  } finally {
    await f.close();
  }
});

test("service acquisition refusal never dispatches previously queued work", async () => {
  const f = await fixture();
  try {
    const job = await f.store.submit(input);
    const before = await SqliteJobStore.inspect(f.path);
    await assert.rejects(
      JobService.open(f.driver, {
        store: f.store,
        handoff: { snapshot: before.snapshot },
        resolvePrincipal: () => principal,
      }),
      { code: "JOB_HANDOFF_BLOCKED" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await SqliteJobStore.inspect(f.path), before);
    const kept = await f.store.read(principal.subject, job.info.id);
    assert.equal(kept.info.state, "queued");
    assert.deepEqual(kept.events, []);
  } finally {
    await f.close();
  }
});

test("authorization finishing after service shutdown cannot mutate the adopted queue", async () => {
  const f = await fixture();
  let service: JobService | undefined;
  let allow!: (principal: JobPrincipal) => void;
  try {
    const job = await f.store.submit(input);
    await f.store.cancel(principal.subject, job.info.id);
    const observation = await SqliteJobStore.inspect(f.path);
    const policy = new Promise<JobPrincipal>((resolve) => {
      allow = resolve;
    });
    service = await JobService.open(f.driver, {
      store: f.store,
      handoff: { snapshot: observation.snapshot },
      resolvePrincipal: () => policy,
    });
    const rejected = assert.rejects(
      service.cancel({ id: job.info.id }, "storage-test"),
    );
    await service.close();
    const stopped = await SqliteJobStore.inspect(f.path);
    allow(principal);
    await rejected;
    assert.deepEqual(await SqliteJobStore.inspect(f.path), stopped);
    assert.equal(stopped.lease, "none");
  } finally {
    allow?.(principal);
    await service?.close();
    await f.close();
  }
});

test("the actual HTTP host starts with handoff and drains its acquired store", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const snapshot = (await SqliteJobStore.inspect(f.path)).snapshot;
    const token = randomBytes(32).toString("hex");
    server = await serve(f.driver, {
      host: "127.0.0.1",
      port: 0,
      tokens: [
        {
          subject: principal.subject,
          token,
          providers: [],
          jobs: ["read"],
        },
      ],
      jobs: { store: f.store, handoff: { snapshot } },
    });
    const response = await fetch(`${server.url}/v1/protocol`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const protocol = (await response.json()) as { features: string[] };
    assert.ok(protocol.features.includes("durable-jobs"));
    assert.deepEqual(f.driver.listProviders(), []);
    await server.close();
    assert.equal((await SqliteJobStore.inspect(f.path)).lease, "none");
  } finally {
    await server?.close();
    await f.close();
  }
});

test("configured handoff rejects a missing original database instead of creating a replacement", async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, "missing.sqlite");
    const tokenPath = join(f.root, "operator.token");
    await writeFile(tokenPath, randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
    const config = validateHostConfig({
      version: 1,
      providers: [],
      listen: { host: "127.0.0.1", port: 0 },
      tokens: [
        {
          id: "operator",
          subject: principal.subject,
          providers: [],
          jobs: ["read"],
          tokenRef: { file: tokenPath },
        },
      ],
      jobs: { ...options, path: missing },
    });
    const configPath = join(f.root, "config.json");
    const raw = JSON.stringify(config);
    await writeFile(configPath, raw, { mode: 0o600 });
    const settings = await configuredServer(config, configPath);
    assert.ok(settings.jobs);
    settings.jobs.handoff = {
      snapshot: (await SqliteJobStore.inspect(f.path)).snapshot,
    };
    await assert.rejects(serve(f.driver, settings), { code: "ENOENT" });
    await assert.rejects(stat(missing), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), raw);
    assert.deepEqual(f.driver.listProviders(), []);
  } finally {
    await f.close();
  }
});

test("invalid selected handoff is rejected before any store factory runs", async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, "must-not-create.sqlite");
    await assert.rejects(
      serve(f.driver, {
        host: "127.0.0.1",
        port: 0,
        tokens: [
          {
            subject: principal.subject,
            token: randomBytes(32).toString("hex"),
            providers: [],
          },
        ],
        jobs: {
          handoff: JSON.parse("null"),
          store: () => SqliteJobStore.open(missing, options),
        },
      }),
      { code: "INVALID_JOB_HANDOFF" },
    );
    await assert.rejects(stat(missing), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test(
  "failed lease release still closes the service-owned SQLite connection",
  { skip: process.platform !== "linux" },
  async () => {
    const f = await fixture();
    const databasePath = await realpath(f.path);
    let service: JobService | undefined;
    let locker: DatabaseSync | undefined;
    const descriptors = async () =>
      (
        await Promise.all(
          (await readdir("/proc/self/fd")).map(
            async (fd) => await readlink(`/proc/self/fd/${fd}`).catch(() => ""),
          ),
        )
      ).filter((target) => target === databasePath).length;
    try {
      const baseline = await descriptors();
      service = await JobService.open(f.driver, {
        store: f.store,
        handoff: { snapshot: (await SqliteJobStore.inspect(f.path)).snapshot },
        resolvePrincipal: () => principal,
      });
      assert.ok((await descriptors()) > baseline);
      // A real competing writer lock, without modifying any job or lease row.
      locker = new DatabaseSync(f.path);
      locker.exec("BEGIN IMMEDIATE");
      await assert.rejects(service.close(), { code: "JOB_STORE_ERROR" });
      locker.exec("ROLLBACK");
      locker.close();
      locker = undefined;
      // SQLite can defer closing shared inode descriptors until the caller's handle closes too.
      await f.store.close();
      assert.equal(await descriptors(), 0);
    } finally {
      locker?.close();
      await service?.close().catch(() => {});
      await f.close();
    }
  },
);
