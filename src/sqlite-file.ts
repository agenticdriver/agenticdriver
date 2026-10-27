import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DriverError } from "./errors.js";

const privateFile = (stat: { mode: number; uid: number }) =>
  process.platform === "win32" ||
  ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());

/** Validate private SQLite storage without closing descriptors on a live database inode. */
export async function sqliteFile(
  path: string,
  create: boolean,
  kind: "JOB" | "INDEX",
) {
  const absolute = resolve(path),
    parent = dirname(absolute);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !privateFile(directory)
  )
    throw new DriverError(
      `${kind}_STORAGE_UNSAFE`,
      "Use a private, host-owned directory for the SQLite database.",
    );
  const canonical = join(await realpath(parent), basename(absolute));
  // Closing any raw descriptor for a database can drop SQLite's POSIX locks.
  // Finish creating a private inode before publishing its database pathname.
  const exists = await lstat(canonical).catch(
    (error: NodeJS.ErrnoException) => {
      if (create && error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!exists) {
    const staging = join(parent, `.sqlite-create-${randomUUID()}`);
    try {
      await writeFile(staging, "", { flag: "wx", mode: 0o600 });
      await link(staging, canonical).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await rm(staging, { force: true });
    }
  }
  const stat = await lstat(canonical, { bigint: true });
  const identity = `${stat.dev}:${stat.ino}`;
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    !privateFile({ mode: Number(stat.mode), uid: Number(stat.uid) })
  )
    throw new DriverError(
      `${kind}_STORAGE_UNSAFE`,
      "The SQLite database must be a private regular file with one link.",
    );
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
        `${kind}_STORAGE_UNSAFE`,
        "SQLite database sidecars must be private regular files.",
      );
  }
  return { path: canonical, identity };
}
