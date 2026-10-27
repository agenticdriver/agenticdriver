import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DriverError } from "./errors.js";

const privateFile = (stat: { mode: number; uid: number }) =>
  process.platform === "win32" ||
  ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());

/** Private SQLite layout and file boundary shared by runtime and inspection. */
export async function openJobDatabase(path: string, initialize: boolean) {
  const absolute = resolve(path),
    parent = dirname(absolute);
  if (initialize) await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !privateFile(directory)
  )
    throw new DriverError(
      "JOB_STORAGE_UNSAFE",
      "Use a private, host-owned directory for the job database.",
    );
  const canonical = join(await realpath(parent), basename(absolute));
  const file = await open(
    canonical,
    (initialize ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let identity: string;
  try {
    const stat = await file.stat();
    const exact = await file.stat({ bigint: true });
    identity = `${exact.dev}:${exact.ino}`;
    if (!stat.isFile() || stat.nlink !== 1 || !privateFile(stat))
      throw new DriverError(
        "JOB_STORAGE_UNSAFE",
        "The job database must be a private regular file with one link.",
      );
  } finally {
    await file.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const stat = await lstat(canonical + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (
      stat &&
      (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !privateFile(stat))
    )
      throw new DriverError(
        "JOB_STORAGE_UNSAFE",
        "Job database sidecars must be private regular files.",
      );
  }
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new DriverError(
      "SQLITE_UNAVAILABLE",
      "The SQLite job store requires Node 22.13 or later.",
    );
  }
  const db = new sqlite.DatabaseSync(canonical, { readOnly: !initialize });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (
      (!initialize || tables.length > 0) &&
      (db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
        tables.length !== 2 ||
        !tables.every((row) =>
          ["ad_jobs", "ad_job_worker"].includes(String(row.name)),
        ))
    )
      throw new DriverError(
        "JOB_STORAGE_MISMATCH",
        "Use a dedicated AgenticDriver job database; automatic migrations are not enabled.",
      );
    if (initialize)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS ad_jobs (
          id TEXT PRIMARY KEY, subject TEXT NOT NULL, key_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER,
          payload TEXT, bytes INTEGER NOT NULL, reserved INTEGER NOT NULL,
          UNIQUE(subject, key_hash));
        CREATE TABLE IF NOT EXISTS ad_job_worker (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
    return { db, identity };
  } catch (error) {
    db.close();
    throw error;
  }
}
