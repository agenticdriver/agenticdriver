import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteVectorStore } from "../src/sqlite-vector-store.js";

// Real SQLite contention; no embedding provider or generated model result.
test(
  "opening vector storage cannot drop another connection's process-wide locks",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-vector-lock-"));
    const path = join(root, "vectors.sqlite");
    const initial = await SqliteVectorStore.open(path);
    await initial.close();
    const owner = new DatabaseSync(path);
    const locked = () =>
      execFileSync(
        "python3",
        [
          "-c",
          `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1],timeout=0)
try:
 c.execute("BEGIN EXCLUSIVE")
 c.rollback()
 print("unlocked")
except sqlite3.OperationalError as e:
 if e.sqlite_errorcode not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED): raise
 print("locked")
finally:
 c.close()
`,
          path,
        ],
        { encoding: "utf8" },
      ).trim();
    try {
      owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      assert.equal(locked(), "locked");
      await assert.rejects(SqliteVectorStore.open(path));
      assert.equal(
        locked(),
        "locked",
        "File validation released another connection's SQLite lock",
      );
      owner.exec("ROLLBACK");
      const reopened = await SqliteVectorStore.open(path);
      await reopened.close();
    } finally {
      owner.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
