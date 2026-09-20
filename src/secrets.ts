import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { DriverError } from "./errors.js";
import { runProcess } from "./providers/local-cli.js";

export const SecretReferenceSchema = z.union([
  z
    .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) })
    .strict(),
  z.object({ file: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      keychain: z
        .object({
          service: z.string().min(1).max(128),
          account: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
]);
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
export type SecretResolver = (reference: SecretReference) => Promise<string>;

/** References are trusted local configuration. Secrets are returned only to the caller, never logged. */
export function secretResolver(directory: string): SecretResolver {
  return async (reference) => {
    if ("env" in reference) return process.env[reference.env] ?? "";
    if ("file" in reference) {
      let handle;
      try {
        handle = await open(
          resolve(directory, reference.file),
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        const info = await handle.stat();
        if (
          !info.isFile() ||
          (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        )
          throw new DriverError(
            "SECRET_PERMISSIONS",
            "Secret files must be regular files private to the host account (mode 0600 or 0400 on POSIX systems).",
          );
        const buffer = Buffer.alloc(65_537);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            size,
            buffer.length - size,
            null,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 65_536)
          throw new DriverError(
            "SECRET_TOO_LARGE",
            "A referenced secret exceeds 64 KiB.",
          );
        return new TextDecoder("utf-8", { fatal: true })
          .decode(buffer.subarray(0, size))
          .trimEnd();
      } catch (error) {
        if (error instanceof DriverError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new DriverError(
          "SECRET_UNAVAILABLE",
          "The referenced secret file could not be read.",
        );
      } finally {
        await handle?.close();
      }
    }
    const { service, account } = reference.keychain;
    if (!["linux", "darwin"].includes(process.platform))
      throw new DriverError(
        "SECRET_STORE_UNAVAILABLE",
        "Use a service-supplied environment or private file reference on this operating system.",
      );
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
      ].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    );
    try {
      const output = await runProcess(
        process.platform === "darwin" ? "/usr/bin/security" : "secret-tool",
        process.platform === "darwin"
          ? ["find-generic-password", "-s", service, "-a", account, "-w"]
          : ["lookup", "service", service, "account", account],
        { env, signal: AbortSignal.timeout(5000) },
      );
      if (Buffer.byteLength(output) > 65_536) throw new Error("oversize");
      return output.trimEnd();
    } catch {
      throw new DriverError(
        "SECRET_STORE_UNAVAILABLE",
        "The OS keychain entry could not be read. Check the secret-store helper, unlocked session and configured entry, or supply a private file/environment reference.",
      );
    }
  };
}

export async function singleLineSecret(
  resolver: SecretResolver,
  reference: SecretReference,
  minimum = 1,
): Promise<string> {
  const value = (await resolver(reference)).trim();
  if (value.length < minimum || value.length > 4096 || /[\r\n\0]/.test(value))
    throw new DriverError(
      "AUTH_REQUIRED",
      "Supply a valid single-line credential through its configured secret reference.",
    );
  return value;
}
