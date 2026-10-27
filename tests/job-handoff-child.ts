import { once } from "node:events";
import { SqliteJobStore } from "../src/sqlite-job-store.js";

// Separate-process storage contender. No provider, model, or successful result is installed.
const [path, snapshot, owner] = process.argv.slice(2);
if (!path || !snapshot || !owner || !process.send)
  throw new Error("Storage contender requires IPC and explicit inputs.");
const store = await SqliteJobStore.openExisting(path, {
  retentionMs: 60_000,
  maxJobs: 10,
  maxJobsPerSubject: 10,
});
let bound: SqliteJobStore | undefined;
let final: { phase: string; code?: string } | undefined;
try {
  const start = once(process, "message");
  process.send({ phase: "ready" });
  await start;
  try {
    bound = await store.acquireQuiet(owner, 60_000, snapshot);
  } catch (error) {
    final = {
      phase: "refused",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "UNEXPECTED",
    };
  }
  if (bound) {
    const release = once(process, "message");
    process.send({ phase: "accepted" });
    await release;
    await bound.release(owner);
    final = { phase: "released" };
  }
} finally {
  await bound?.close();
  await store.close();
  if (final) process.send(final);
  process.disconnect();
}
