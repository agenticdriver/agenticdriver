import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DriverError } from "./errors.js";
import { cliEnvironment, runProcess } from "./providers/cli-process.js";
import {
  ProviderRuntimeRequestSchema,
  type ProviderRuntimeInfo,
  type ProviderRuntimes,
} from "./runtime-types.js";

// Official release asset digest; the extracted executable was independently hashed.
export const CODEX_RUNTIME = Object.freeze({
  version: "0.157.0" as const,
  platform: "linux-x64" as const,
  url: "https://github.com/openai/codex/releases/download/rust-v0.157.0/codex-x86_64-unknown-linux-musl.tar.gz",
  member: "codex-x86_64-unknown-linux-musl",
  totalBytes: 107_842_066,
  archiveSha256:
    "db3fe3adaa35c50edfb68a988a117782fe3492960fb63d7003eb6748ccc0657b",
  binarySha256:
    "1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258",
  binaryBytes: 285_340_072,
});
const messages: Record<string, string> = {
  RUNTIME_DOWNLOAD_FAILED:
    "The official runtime download failed. Check this host's network and try again.",
  RUNTIME_INTEGRITY_FAILED:
    "Runtime integrity checks failed. No executable was installed.",
  RUNTIME_STORE_UNSAFE:
    "The private runtime directory is unavailable or unsafe. Ask the host operator to check it.",
  RUNTIME_STORAGE_REQUIRED:
    "This host needs at least 600 MiB free to install the qualified runtime.",
  RUNTIME_DAMAGED:
    "The existing managed runtime failed integrity checks. Ask the host operator to inspect it before reinstalling.",
  RUNTIME_INSTALL_FAILED:
    "The host could not install the runtime. Check its filesystem and tar command before retrying.",
  RUNTIME_CLEANUP_FAILED:
    "The host could not remove installation staging or its lock. Ask the host operator to inspect the private runtime directory before retrying.",
};
function fail(code: string): never {
  throw new DriverError(code, messages[code]!);
}
async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    info.mode & 0o077
  )
    fail("RUNTIME_STORE_UNSAFE");
}
async function verifiedFile(
  file: string,
  expectedBytes: number,
  expectedHash: string,
) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== expectedBytes ||
      before.uid !== process.getuid!() ||
      before.nlink !== 1 ||
      before.mode & 0o077
    )
      fail("RUNTIME_INTEGRITY_FAILED");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat();
    if (
      hash.digest("hex") !== expectedHash ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("RUNTIME_INTEGRITY_FAILED");
    return [
      after.dev,
      after.ino,
      after.size,
      after.mtimeMs,
      after.ctimeMs,
      after.mode,
    ].join(":");
  } finally {
    await handle.close();
  }
}
async function download(
  file: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  let url: string = CODEX_RUNTIME.url;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { Accept: "application/octet-stream" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) fail("RUNTIME_DOWNLOAD_FAILED");
    const next = new URL(location, url);
    if (
      next.protocol !== "https:" ||
      next.username ||
      next.password ||
      ![
        "https://github.com",
        "https://release-assets.githubusercontent.com",
        "https://objects.githubusercontent.com",
      ].includes(next.origin)
    )
      fail("RUNTIME_DOWNLOAD_FAILED");
    url = next.href;
  }
  if (
    !response?.ok ||
    !response.body ||
    response.headers.get("content-length") !== String(CODEX_RUNTIME.totalBytes)
  ) {
    await response?.body?.cancel();
    fail("RUNTIME_DOWNLOAD_FAILED");
  }
  const handle = await open(file, "wx", 0o600),
    hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > CODEX_RUNTIME.totalBytes) fail("RUNTIME_INTEGRITY_FAILED");
      hash.update(chunk);
      await handle.writeFile(chunk);
      progress(bytes);
    }
    if (
      bytes !== CODEX_RUNTIME.totalBytes ||
      hash.digest("hex") !== CODEX_RUNTIME.archiveSha256
    )
      fail("RUNTIME_INTEGRITY_FAILED");
    await handle.sync();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await handle.close();
  }
}

/** Explicit installs only. No package manager, shell installer, account interaction or model execution. */
export async function providerRuntimes(options: {
  directory: string;
}): Promise<ProviderRuntimes> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new DriverError(
      "RUNTIME_UNAVAILABLE",
      "Managed runtime installation currently supports qualified Linux x64 hosts.",
    );
  const root = join(options.directory, "provider-runtimes"),
    target = join(root, "codex-0.157.0-linux-x64"),
    binary = join(target, CODEX_RUNTIME.member);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(root);
  let closed = false,
    queue: Promise<unknown> = Promise.resolve(),
    verifiedStamp: string | undefined;
  let attempt:
    | {
        public: ProviderRuntimeInfo;
        owner: string;
        abort: AbortController;
        done: Promise<void>;
      }
    | undefined;
  const base = (): ProviderRuntimeInfo => ({
    kind: "codex",
    version: CODEX_RUNTIME.version,
    platform: CODEX_RUNTIME.platform,
    phase: "missing",
    archiveSha256: CODEX_RUNTIME.archiveSha256,
    downloadBytes: 0,
    totalBytes: CODEX_RUNTIME.totalBytes,
    canCancel: false,
  });
  async function installed(): Promise<boolean> {
    await privateDirectory(root);
    try {
      await privateDirectory(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("RUNTIME_DAMAGED");
    }
    try {
      const info = await lstat(binary);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !(info.mode & 0o100) ||
        info.uid !== process.getuid!() ||
        info.nlink !== 1 ||
        info.mode & 0o077
      )
        fail("RUNTIME_DAMAGED");
      const stamp = [
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        info.mode,
      ].join(":");
      if (stamp !== verifiedStamp)
        verifiedStamp = await verifiedFile(
          binary,
          CODEX_RUNTIME.binaryBytes,
          CODEX_RUNTIME.binarySha256,
        );
      return true;
    } catch {
      fail("RUNTIME_DAMAGED");
    }
  }
  const active = () =>
    attempt && ["downloading", "verifying"].includes(attempt.public.phase);
  async function view(caller: string) {
    if (attempt && active())
      return {
        version: 1 as const,
        runtimes: [{ ...attempt.public, canCancel: caller === attempt.owner }],
      };
    try {
      if (await installed()) {
        const result = {
          ...(attempt?.public ?? base()),
          phase: "installed" as const,
          downloadBytes: CODEX_RUNTIME.totalBytes,
          canCancel: false,
          binary,
        };
        delete result.error;
        return { version: 1 as const, runtimes: [result] };
      }
      return {
        version: 1 as const,
        runtimes: [
          structuredClone(
            attempt?.public.phase === "installed"
              ? base()
              : (attempt?.public ?? base()),
          ),
        ],
      };
    } catch (error) {
      const code =
        error instanceof DriverError && messages[error.code]
          ? error.code
          : "RUNTIME_STORE_UNSAFE";
      return {
        version: 1 as const,
        runtimes: [
          {
            ...base(),
            phase: "failed" as const,
            error: { code, message: messages[code]! },
          },
        ],
      };
    }
  }
  async function install(owner: string) {
    if (closed)
      throw new DriverError(
        "RUNTIME_UNAVAILABLE",
        "The host is shutting down.",
      );
    if (active())
      throw new DriverError(
        "RUNTIME_BUSY",
        "An installation is already running. Check its status before retrying.",
      );
    // A terminal phase can be visible while its staging/lock cleanup finishes.
    await attempt?.done;
    if (await installed()) return view(owner);
    const space = await statfs(root);
    if (space.bavail * space.bsize < 600 * 1024 * 1024)
      fail("RUNTIME_STORAGE_REQUIRED");
    let lock;
    try {
      lock = await open(join(root, ".install-lock"), "wx", 0o600);
    } catch {
      throw new DriverError(
        "RUNTIME_BUSY",
        "Another host process holds the runtime installation lock. Ask its operator to check it.",
      );
    }
    let stage: string;
    try {
      stage = await mkdtemp(join(root, ".codex-install-"));
    } catch (error) {
      await lock.close();
      await rm(join(root, ".install-lock"), { force: true });
      throw error;
    }
    const entry: NonNullable<typeof attempt> = {
      public: {
        ...base(),
        id: randomUUID(),
        phase: "downloading",
        updatedAt: new Date().toISOString(),
      },
      owner,
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    attempt = entry;
    const touch = () => {
      entry.public.updatedAt = new Date().toISOString();
    };
    entry.done = Promise.resolve().then(async () => {
      try {
        const archive = join(stage, "runtime.tar.gz");
        await download(archive, entry.abort.signal, (bytes) => {
          entry.public.downloadBytes = bytes;
          touch();
        });
        entry.public.phase = "verifying";
        touch();
        await runProcess(
          "tar",
          [
            "--extract",
            "--gzip",
            "--file",
            archive,
            "--directory",
            stage,
            "--no-same-owner",
            "--no-same-permissions",
            "--",
            CODEX_RUNTIME.member,
          ],
          {
            env: { PATH: process.env.PATH },
            cwd: stage,
            signal: entry.abort.signal,
          },
        );
        const executable = join(stage, CODEX_RUNTIME.member);
        await chmod(executable, 0o700);
        await verifiedFile(
          executable,
          CODEX_RUNTIME.binaryBytes,
          CODEX_RUNTIME.binarySha256,
        );
        // Version inspection uses a new empty home, never a native account profile.
        const accountDirectory = join(stage, ".version-profile");
        await mkdir(accountDirectory, { mode: 0o700 });
        const version = await runProcess(executable, ["--version"], {
          env: { ...cliEnvironment(), CODEX_HOME: accountDirectory },
          cwd: stage,
          signal: entry.abort.signal,
        });
        if (version.trim() !== "codex-cli 0.157.0")
          fail("RUNTIME_INTEGRITY_FAILED");
        await rm(accountDirectory, { recursive: true, force: true });
        await rm(archive);
        await writeFile(
          join(stage, "install.json"),
          JSON.stringify({
            version: 1,
            kind: "codex",
            runtimeVersion: CODEX_RUNTIME.version,
            archiveSha256: CODEX_RUNTIME.archiveSha256,
            binarySha256: CODEX_RUNTIME.binarySha256,
            installedAt: new Date().toISOString(),
          }) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        entry.abort.signal.throwIfAborted();
        // Same-filesystem publication. A complete install is never overwritten.
        await rename(stage, target);
        entry.public.phase = "installed";
        entry.public.binary = binary;
        touch();
      } catch (error) {
        entry.public.phase = entry.abort.signal.aborted
          ? "cancelled"
          : "failed";
        if (!entry.abort.signal.aborted) {
          const code =
            error instanceof DriverError && messages[error.code]
              ? error.code
              : error instanceof TypeError
                ? "RUNTIME_DOWNLOAD_FAILED"
                : "RUNTIME_INSTALL_FAILED";
          entry.public.error = { code, message: messages[code]! };
        }
        touch();
      } finally {
        const cleanup = await Promise.allSettled([
          rm(stage, { recursive: true, force: true }),
          lock.close(),
        ]);
        const unlock = await rm(join(root, ".install-lock"), {
          force: true,
        }).then(
          () => true,
          () => false,
        );
        if (
          entry.public.phase !== "installed" &&
          (!unlock || cleanup.some((result) => result.status === "rejected"))
        ) {
          entry.public.phase = "failed";
          entry.public.error = {
            code: "RUNTIME_CLEANUP_FAILED",
            message: messages.RUNTIME_CLEANUP_FAILED!,
          };
          touch();
        }
      }
    });
    // HTTP acknowledges scheduling. An explicit cancel or host shutdown owns termination.
    return view(owner);
  }
  return {
    async request(input, caller) {
      const parsed = ProviderRuntimeRequestSchema.safeParse(input);
      if (!parsed.success || !caller)
        throw new DriverError(
          "INVALID_RUNTIME_REQUEST",
          "Choose a supported runtime operation.",
        );
      if (closed)
        throw new DriverError(
          "RUNTIME_UNAVAILABLE",
          "The host is shutting down.",
        );
      if (parsed.data.action === "status") return view(caller);
      const request = parsed.data;
      const operation = queue.then(async () => {
        if (request.action === "install") return install(caller);
        if (
          !attempt ||
          attempt.public.id !== request.id ||
          attempt.owner !== caller
        )
          throw new DriverError(
            "RUNTIME_NOT_FOUND",
            "This installation attempt belongs to another connection or is no longer available.",
          );
        if (active()) {
          attempt.abort.abort();
          await attempt.done;
        }
        return view(caller);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async close() {
      closed = true;
      await queue;
      if (attempt) {
        if (active()) attempt.abort.abort();
        await attempt.done;
      }
    },
  };
}
