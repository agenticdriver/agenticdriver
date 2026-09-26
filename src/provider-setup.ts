import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DriverError } from "./errors.js";
import type {
  ManagementSnapshot,
  ProviderManagement,
} from "./management-types.js";
import { codexDeviceSignIn } from "./providers/codex-sign-in.js";
import {
  ProviderSetupRequestSchema,
  type ProviderSetup,
  type ProviderSetupAttempt,
  type ProviderSetupConfig,
} from "./setup-types.js";

const messages: Record<string, string> = {
  SETUP_FAILED:
    "The host could not complete this sign-in. Start a new attempt when it is ready.",
  SETUP_PROTOCOL_ERROR:
    "The native runtime returned an unsupported sign-in response.",
  SETUP_SIGN_IN_FAILED:
    "Codex did not verify sign-in. Check provider account requirements before retrying.",
  SETUP_PROFILE_UNSAFE:
    "A new private account profile is required. Existing sign-ins are preserved.",
  CLI_UNAVAILABLE:
    "The selected native executable could not be started on this host.",
  CLI_UPGRADE_REQUIRED:
    "Select the qualified Codex CLI 0.157.0 executable on this host.",
  CONFIG_CONFLICT:
    "Host settings changed during sign-in. Refresh and start a new attempt.",
  CONFIG_BUSY:
    "Another settings writer holds the host configuration lock. Refresh and retry.",
  CONFIG_WRITE_FAILED:
    "The provider could not be saved. Refresh host settings before retrying.",
  SETUP_EXPIRED: "This sign-in attempt expired. Start a new attempt.",
};
const terminal = (entry: Entry) =>
  ["succeeded", "failed", "cancelled", "expired"].includes(entry.public.phase);
interface Entry {
  public: ProviderSetupAttempt;
  owner: string;
  provider: ProviderSetupConfig;
  directory: string;
  abort: AbortController;
  nativeDone: Promise<unknown>;
  queue: Promise<unknown>;
  published: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
/** Host-owned setup state. Native processes never read or replace a shared account profile. */
export async function providerSetup(options: {
  directory: string;
  snapshot(): ManagementSnapshot;
  configure: ProviderManagement["configure"];
  /** Pure configuration checks run before any native credential interaction. */
  preflight?(provider: ProviderSetupConfig, revision: string): Promise<void>;
  /** Trusted in-process fixture seam; never accepted from configuration or HTTP. */
  native?: typeof codexDeviceSignIn;
}): Promise<ProviderSetup> {
  const root = join(options.directory, "provider-accounts");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.mode & 0o077 || info.uid !== process.getuid!()))
  )
    throw new DriverError(
      "SETUP_PROFILE_UNSAFE",
      messages.SETUP_PROFILE_UNSAFE!,
    );
  const entries = new Map<string, Entry>();
  let closed = false;
  let starts = Promise.resolve();
  const serialize = <T>(
    entry: Entry,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const next = entry.queue.then(operation);
    entry.queue = next.catch(() => {});
    return next;
  };
  const view = (selected: Entry[]) => ({
    version: 1 as const,
    attempts: selected.map((e) => structuredClone(e.public)),
  });
  const touch = (entry: Entry) => {
    entry.public.updatedAt = new Date().toISOString();
  };
  async function finish(
    entry: Entry,
    phase: "failed" | "cancelled" | "expired",
    code?: string,
  ) {
    if (terminal(entry)) return;
    entry.public.phase = phase;
    delete entry.public.interaction;
    delete entry.public.account;
    if (code)
      entry.public.error = {
        code,
        message: messages[code] ?? messages.SETUP_FAILED!,
      };
    touch(entry);
    clearTimeout(entry.timer);
    entry.abort.abort();
    await entry.nativeDone.catch(() => {});
    if (!entry.published)
      await rm(entry.directory, { recursive: true, force: true });
  }
  const stale = (entry: Entry) =>
    entry.public.revision !== options.snapshot().revision;
  async function current(entry: Entry) {
    if (terminal(entry)) return;
    if (Date.now() >= Date.parse(entry.public.expiresAt))
      await finish(entry, "expired", "SETUP_EXPIRED");
    else if (stale(entry)) await finish(entry, "failed", "CONFIG_CONFLICT");
  }
  async function start(
    input: Extract<
      ReturnType<typeof ProviderSetupRequestSchema.parse>,
      { action: "start" }
    >,
    caller: string,
  ) {
    if (closed)
      throw new DriverError("SETUP_UNAVAILABLE", "The host is shutting down.");
    const config = options.snapshot();
    if (input.revision !== config.revision)
      throw new DriverError("CONFIG_CONFLICT", messages.CONFIG_CONFLICT!);
    if (
      config.providers.some((p) => p.id === input.provider.id) ||
      [...entries.values()].some(
        (e) => !terminal(e) && e.provider.id === input.provider.id,
      )
    )
      throw new DriverError(
        "SETUP_NEW_INSTANCE_REQUIRED",
        "Use a new provider instance ID. Existing accounts cannot be replaced by sign-in.",
      );
    if (config.providers.length >= 32)
      throw new DriverError(
        "SETUP_CAPACITY",
        "The host's provider instance capacity has been reached.",
      );
    const active = [...entries.values()].filter((e) => !terminal(e));
    if (
      active.length >= 4 ||
      active.filter((e) => e.owner === caller).length >= 2
    )
      throw new DriverError(
        "SETUP_CAPACITY",
        "Finish or cancel a pending sign-in before starting another.",
      );
    for (const [key, e] of entries)
      if (entries.size >= 32 && terminal(e)) entries.delete(key);
    await options.preflight?.(input.provider, input.revision);
    if (closed)
      throw new DriverError("SETUP_UNAVAILABLE", "The host is shutting down.");
    const directory = await mkdtemp(join(root, "codex-"));
    const now = Date.now();
    const entry: Entry = {
      public: {
        id: randomUUID(),
        providerId: input.provider.id,
        accountId: input.provider.accountId,
        name: input.provider.name ?? input.provider.id,
        revision: input.revision,
        method: input.method,
        phase: "starting",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15 * 60_000).toISOString(),
      },
      owner: caller,
      provider: structuredClone(input.provider),
      directory,
      abort: new AbortController(),
      nativeDone: Promise.resolve(),
      queue: Promise.resolve(),
      published: false,
    };
    entries.set(entry.public.id, entry);
    // This is the native credential-flow lifetime, never a model/run timeout.
    entry.timer = setTimeout(() => {
      void serialize(entry, () =>
        finish(entry, "expired", "SETUP_EXPIRED"),
      ).catch(() => {});
    }, 15 * 60_000);
    entry.timer.unref();
    const native = Promise.resolve().then(() =>
      (options.native ?? codexDeviceSignIn)({
        binary: input.provider.binary,
        accountDirectory: directory,
        signal: entry.abort.signal,
        interaction(value) {
          if (!terminal(entry)) {
            entry.public.phase = "waiting";
            entry.public.interaction = value;
            touch(entry);
          }
        },
        verifying() {
          if (!terminal(entry)) {
            entry.public.phase = "verifying";
            delete entry.public.interaction;
            touch(entry);
          }
        },
      }),
    );
    entry.nativeDone = native;
    void native
      .then(
        (account) =>
          serialize(entry, async () => {
            await current(entry);
            if (!terminal(entry)) {
              entry.public.phase = "ready";
              entry.public.account = account;
              delete entry.public.interaction;
              touch(entry);
            }
          }),
        (error) =>
          serialize(entry, async () => {
            const code =
              error instanceof DriverError && messages[error.code]
                ? error.code
                : "SETUP_FAILED";
            await finish(entry, "failed", code);
          }),
      )
      .catch(() => {});
    return view([entry]);
  }
  return {
    async request(input, caller) {
      if (closed)
        throw new DriverError(
          "SETUP_UNAVAILABLE",
          "The host is shutting down.",
        );
      const parsed = ProviderSetupRequestSchema.safeParse(input);
      if (!parsed.success || !caller)
        throw new DriverError(
          "INVALID_SETUP_REQUEST",
          "Choose a supported provider setup operation.",
        );
      const request = parsed.data;
      if (request.action === "start") {
        const next = starts.then(() => start(request, caller));
        starts = next.then(
          () => {},
          () => {},
        );
        return next;
      }
      if (request.action === "list") {
        const owned = [...entries.values()].filter((e) => e.owner === caller);
        await Promise.all(owned.map((e) => serialize(e, () => current(e))));
        return view(owned);
      }
      const entry = entries.get(request.id);
      if (!entry || entry.owner !== caller)
        throw new DriverError(
          "SETUP_NOT_FOUND",
          "This sign-in attempt is unavailable to this connection.",
        );
      return serialize(entry, async () => {
        await current(entry);
        if (request.action === "status") return view([entry]);
        if (terminal(entry))
          throw new DriverError(
            "SETUP_FINISHED",
            "This sign-in attempt has finished. Refresh its status.",
          );
        if (request.action === "cancel") {
          await finish(entry, "cancelled");
          return view([entry]);
        }
        if (entry.public.phase !== "ready")
          throw new DriverError(
            "SETUP_NOT_READY",
            "Wait for native account verification before connecting this account.",
          );
        entry.public.phase = "verifying";
        touch(entry);
        try {
          await options.configure({
            revision: entry.public.revision,
            provider: { ...entry.provider, accountDirectory: entry.directory },
          });
          entry.published = true;
          entry.public.phase = "succeeded";
          touch(entry);
          clearTimeout(entry.timer);
        } catch (error) {
          const code =
            error instanceof DriverError && messages[error.code]
              ? error.code
              : "SETUP_FAILED";
          await finish(entry, "failed", code);
        }
        return view([entry]);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await starts;
      await Promise.all(
        [...entries.values()].map((e) =>
          serialize(e, async () => {
            clearTimeout(e.timer);
            if (!terminal(e)) await finish(e, "cancelled");
          }),
        ),
      );
    },
  };
}
