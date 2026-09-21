/** Credential-free durable job example using the installed public package. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver, AgenticClient, SqliteJobStore } from "agenticdriver";
import { mockProvider } from "agenticdriver/providers";
import { serve } from "agenticdriver/server";

const directory = await mkdtemp(
  join(tmpdir(), "agenticdriver-installed-jobs-"),
);
let store = await SqliteJobStore.open(join(directory, "jobs.sqlite"), {
  retentionMs: 60_000,
});
let calls = 0;
const driver = new AgenticDriver({
  providers: [
    mockProvider(() => {
      calls++;
      return { text: "synthetic background result" };
    }),
  ],
  usage: { hostId: "installed-host", accounts: { mock: "synthetic-account" } },
});
const token = "synthetic-example-token-32-characters";
const options = {
  port: 0,
  tokens: [
    {
      token,
      subject: "synthetic-subject",
      providers: ["mock"],
      jobs: ["submit", "read", "cancel"] as const,
    },
  ],
};
const start = () =>
  serve(driver, {
    ...options,
    tokens: options.tokens.map((entry) => ({
      ...entry,
      jobs: [...entry.jobs],
    })),
    jobs: { store, pollIntervalMs: 10 },
  });
let host = await start();
try {
  let client = new AgenticClient({ url: host.url, token });
  const submission = {
    key: "synthetic-stage-v1",
    request: {
      provider: "mock",
      model: "demo",
      input: "A synthetic background stage",
    },
  };
  const job = await client.submitJob(submission);
  const identity = { id: job.id };
  let status = job;
  while (status.state === "queued" || status.state === "running") {
    await delay(10);
    status = await client.readJob(identity);
  }
  assert.equal(status.state, "completed");
  await host.close();
  await store.close();
  store = await SqliteJobStore.open(join(directory, "jobs.sqlite"), {
    retentionMs: 60_000,
  });
  host = await start();
  client = new AgenticClient({ url: host.url, token });
  assert.equal((await client.submitJob(submission)).id, job.id);
  let cursor = 0;
  do {
    const page = await client.jobEvents({
      ...identity,
      after: cursor,
      limit: 2,
    });
    cursor = page.nextCursor;
  } while (cursor < status.cursor);
  assert.equal(calls, 1);
  assert.equal((await client.cancelJob(identity)).state, "completed");
  console.log("Installed durable job submit, reopen and replay passed");
} finally {
  await host.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
