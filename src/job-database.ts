import { sqliteFile } from "./sqlite-file.js";
import type { DatabaseSync } from "node:sqlite";
import { DriverError } from "./errors.js";

/** Private SQLite layout and file boundary shared by runtime and inspection. */
export async function openJobDatabase(
  path: string,
  mode: "initialize" | "read" | "existing",
) {
  const initialize = mode === "initialize";
  const writable = mode !== "read";
  const { path: canonical, identity } = await sqliteFile(
    path,
    initialize,
    "JOB",
  );
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new DriverError(
      "SQLITE_UNAVAILABLE",
      "The SQLite job store requires Node 22.13 or later.",
    );
  }
  const db = new sqlite.DatabaseSync(canonical, { readOnly: !writable });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const version = Number(
      db.prepare("PRAGMA user_version").get()?.user_version,
    );
    const names = tables.map((row) => String(row.name)).sort();
    const expected =
      version === 2
        ? ["ad_job_generation", "ad_job_worker", "ad_jobs"]
        : ["ad_job_worker", "ad_jobs"];
    if (
      (!initialize || tables.length > 0) &&
      (![1, 2].includes(version) ||
        JSON.stringify(names) !== JSON.stringify(expected))
    )
      throw new DriverError(
        "JOB_STORAGE_MISMATCH",
        "Use a dedicated AgenticDriver job database; automatic migrations are not enabled.",
      );
    if (writable)
      db.exec(
        "PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;",
      );
    if (initialize) db.exec("PRAGMA journal_mode=WAL;");
    if (initialize && tables.length === 0)
      db.exec(`
        CREATE TABLE IF NOT EXISTS ad_jobs (
          id TEXT PRIMARY KEY, subject TEXT NOT NULL, key_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER,
          payload TEXT, bytes INTEGER NOT NULL, reserved INTEGER NOT NULL,
          UNIQUE(subject, key_hash));
        CREATE TABLE IF NOT EXISTS ad_job_worker (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
    return { db, identity, path: canonical, generation: jobGeneration(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function jobGeneration(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 1) return 0;
  if (version !== 2)
    throw new DriverError(
      "JOB_STORAGE_MISMATCH",
      "Unknown job storage version.",
    );
  const generation = Number(
    db.prepare("SELECT generation FROM ad_job_generation WHERE id=1").get()
      ?.generation,
  );
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new DriverError(
      "JOB_STORAGE_MISMATCH",
      "Invalid job ownership generation.",
    );
  return generation;
}
