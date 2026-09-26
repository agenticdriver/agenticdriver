import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AgenticClient,
  DriverError,
  connectionInvitation,
  connectionTarget,
} from "@agenticdriver/sdk/client";
import { managedHost } from "@agenticdriver/sdk/management";
import { configuredServer, secretResolver } from "@agenticdriver/sdk/host";
import { serve } from "@agenticdriver/sdk/server";
import {
  connectClient,
  connectedClient,
  withConnections,
  CreateInvitationSchema,
} from "@agenticdriver/sdk/connections";
import { providerPanel, PanelRequestSchema } from "@agenticdriver/sdk/panel";
import { UsageStatClient } from "@agenticdriver/sdk/usagestat";
import { providerPresentation } from "@agenticdriver/sdk/catalog";

const id = z.union([z.literal("local"), z.uuid()]);
const remoteSchema = z
  .object({
    id: z.uuid(),
    label: z.string().trim().min(1).max(80),
    url: z.string(),
    expiresAt: z.string(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    selectedHost: id,
    startLocalAtLaunch: z.boolean(),
    localPort: z.number().int().min(1).max(65535).optional(),
    hosts: z.array(remoteSchema).max(32),
    usage: z
      .object({
        url: z.string().max(8192),
        tokenFile: z
          .string()
          .regex(/^usage-[a-f0-9-]+\.token$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("overview") }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z
    .object({
      action: z.literal("stop"),
      interrupt: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal("select"), hostId: id }).strict(),
  z.object({ action: z.literal("startup"), enabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("connect"),
      label: z.string().trim().min(1).max(80),
      invitation: z.string().min(1).max(16384),
    })
    .strict(),
  z.object({ action: z.literal("forget"), hostId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("panel"),
      hostId: id,
      request: PanelRequestSchema,
    })
    .strict(),
  z.object({ action: z.literal("connections"), hostId: id }).strict(),
  z
    .object({
      action: z.literal("invite"),
      hostId: id,
      input: CreateInvitationSchema,
    })
    .strict(),
  z
    .object({ action: z.literal("revoke"), hostId: id, connectionId: z.uuid() })
    .strict(),
  z.object({ action: z.literal("usage") }).strict(),
  z
    .object({
      action: z.literal("usage-settings"),
      url: z.string().min(1).max(8192),
      token: z.string().trim().min(1).max(16384).optional(),
      clearToken: z.boolean().default(false),
    })
    .strict(),
]);
const fail = (code, message) => {
  throw new DriverError(code, message);
};
export function publicError(error) {
  // Never expose fetch URLs, upstream bodies, process output, stack traces or secrets.
  if (error instanceof DriverError)
    return { code: error.code, message: error.message };
  return {
    code: "DESKTOP_UNAVAILABLE",
    message:
      "The operation failed. Check the selected host or Usagestat service and try again.",
  };
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.mode & 0o077 || info.uid !== process.getuid()))
  )
    fail(
      "PRIVATE_DIRECTORY",
      "The desktop data directory must be owned by you and private.",
    );
}
async function writeJson(path, data) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(data, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
const text = (v, max = 256) =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const number = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The controller is backend-only and runs in a bundled Node child, never in the renderer. */
export async function desktopController(directory, { autoStart = true } = {}) {
  await privateDirectory(directory);
  const lockPath = join(directory, "desktop.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Do not steal a live lock or terminate another process. Recover only an absent owner.
    const old = await secretResolver(directory)({ file: lockPath });
    if (!/^\d+\n?$/.test(old))
      fail(
        "DESKTOP_BUSY",
        "The desktop profile is locked. Check its owning process before recovering it.",
      );
    let absent = false;
    try {
      process.kill(Number(old.trim()), 0);
    } catch (e) {
      absent = e.code === "ESRCH";
    }
    if (!absent)
      fail("DESKTOP_BUSY", "Another desktop process owns this profile.");
    await rm(lockPath);
    lock = await open(lockPath, "wx", 0o600);
  }
  await lock.writeFile(String(process.pid) + "\n");
  const secrets = secretResolver(directory);
  let server,
    host,
    localClient,
    startupError,
    state,
    closed = false,
    closing = false;
  let metadata = [];
  const configPath = join(directory, "local", "config.json");
  const settingsPath = join(directory, "settings.json");
  const clients = new Map();
  let queue = Promise.resolve();
  const serial = (fn) => {
    const pending = queue.then(fn);
    queue = pending.catch(() => {});
    return pending;
  };
  const save = async (next) => {
    next = stateSchema.parse(next);
    await writeJson(settingsPath, next);
    state = next;
  };
  const record = (hostId) => {
    const found = state.hosts.find((h) => h.id === hostId);
    if (!found) fail("HOST_NOT_FOUND", "Select a saved host.");
    return found;
  };
  const profilePath = (hostId) =>
    join(directory, "connections", hostId, "profile.json");
  async function client(hostId) {
    if (hostId === "local") {
      if (!localClient)
        fail(
          "HOST_STOPPED",
          "Start the local host to manage providers and connections.",
        );
      return localClient;
    }
    record(hostId);
    let entry = clients.get(hostId);
    // Reload expiry and token on each operation; connectedClient keeps token loading backend-only.
    entry = await connectedClient(profilePath(hostId));
    clients.set(hostId, entry);
    return entry;
  }
  const connection = (hostId) =>
    hostId === "local"
      ? { id: "local", label: "This computer", url: server?.url }
      : { ...record(hostId) };
  async function start() {
    if (server) return;
    const localDir = join(directory, "local");
    await privateDirectory(localDir);
    // A half-created profile is recoverable without replacing any credential.
    const tokenPath = join(localDir, "operator.token");
    try {
      await writeFile(tokenPath, randomBytes(32).toString("base64url") + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            usage: { hostId: "desktop-" + randomUUID() },
            listen: { host: "127.0.0.1", port: 0 },
            providers: [],
            tokens: [
              {
                id: "desktop-operator",
                subject: "desktop-operator",
                providers: [],
                manageProviders: true,
                tokenRef: { file: "operator.token" },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const candidate = await managedHost(configPath);
    const options = await configuredServer(candidate.config(), configPath);
    let opened;
    try {
      opened = await serve(
        candidate.driver,
        withConnections(
          {
            ...options,
            host: "127.0.0.1",
            port: state.localPort ?? 0,
            management: candidate.management,
          },
          candidate.connections,
        ),
      );
      const port = Number(new URL(opened.url).port);
      if (state.localPort !== port) await save({ ...state, localPort: port });
      const token = (
        await secretResolver(localDir)({ file: "operator.token" })
      ).trim();
      const connected = new AgenticClient({ url: opened.url, token });
      await connected.management();
      server = opened;
      host = candidate;
      localClient = connected;
      startupError = undefined;
    } catch (error) {
      await opened?.close();
      if (error?.code === "EADDRINUSE")
        fail(
          "PORT_IN_USE",
          "The saved local port is in use. Stop the conflicting listener before starting this host.",
        );
      throw error;
    }
  }
  async function activity() {
    if (!host) return { activeRequests: 0, connections: 0 };
    const links = await host.connections.list();
    return {
      activeRequests: links.connections.reduce(
        (n, c) => n + (c.activeRequests ?? 0),
        0,
      ),
      connections: links.connections.length,
    };
  }
  async function stop(interrupt = false) {
    if (!server) return;
    if (!interrupt && (await activity()).activeRequests)
      fail(
        "HOST_BUSY",
        "Requests are in progress. Wait for them to finish or explicitly stop and interrupt them.",
      );
    const owned = server;
    // New UI requests fail before close begins; only this desktop-owned listener is closed.
    localClient = undefined;
    server = undefined;
    host = undefined;
    await owned.close();
  }
  async function overview() {
    return {
      selectedHost: state.selectedHost,
      startLocalAtLaunch: state.startLocalAtLaunch,
      local: {
        id: "local",
        label: "This computer",
        running: Boolean(server),
        url:
          server?.url ??
          (state.localPort ? `http://127.0.0.1:${state.localPort}` : undefined),
        ...(await activity()),
        error: startupError,
      },
      hosts: state.hosts,
      usage: { url: state.usage.url, hasToken: Boolean(state.usage.tokenFile) },
    };
  }
  const panel = (hostId) =>
    providerPanel({
      client: () => client(hostId),
      connection: () => connection(hostId),
      presentations: (providers) =>
        Object.fromEntries(
          providers.map((p) => [
            p.id,
            providerPresentation(p, {
              metadata: metadata.find((m) => m.id === p.usageStatId),
            }),
          ]),
        ),
    });
  async function usage() {
    const upstream = new UsageStatClient({
      url: state.usage.url,
      ...(state.usage.tokenFile
        ? {
            token: async () =>
              (await secrets({ file: state.usage.tokenFile })).trim(),
          }
        : {}),
    });
    const results = await Promise.allSettled([
      upstream.providers(),
      upstream.usage(),
    ]);
    const providers = results[0].status === "fulfilled" ? results[0].value : [];
    metadata = providers.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      brandColor: p.brandColor,
    }));
    const snapshots = results[1].status === "fulfilled" ? results[1].value : [];
    return {
      url: state.usage.url,
      checkedAt: new Date().toISOString(),
      available: results.some((r) => r.status === "fulfilled"),
      sections: Object.fromEntries(
        ["providers", "usage"].map((key, i) => [
          key,
          results[i].status === "fulfilled" ? "available" : "unavailable",
        ]),
      ),
      providers: metadata.slice(0, 1000),
      // Project explicit display fields only. Upstream extension metadata may contain local paths.
      snapshots: snapshots.slice(0, 1000).map((s) => ({
        providerId: s.providerId,
        displayName: s.displayName,
        fetchedAt: s.fetchedAt,
        source: s.source,
        plan: s.plan,
        state: text(s.state),
        metrics: s.metrics.slice(0, 100).map((m) => ({
          type: text(m.type),
          label: text(m.label),
          value: number(m.value) ?? text(m.value, 2000),
          text: text(m.text, 2000),
          subtitle: text(m.subtitle, 2000),
          detail: text(m.detail, 2000),
          used: number(m.used),
          limit: number(m.limit),
          unit: text(m.unit),
          currency: text(m.currency),
          resetsAt: text(m.resetsAt),
          format: ["percent", "dollars", "count"].includes(m.format?.kind)
            ? { kind: m.format.kind, suffix: text(m.format.suffix) }
            : undefined,
          points: Array.isArray(m.points)
            ? m.points
                .slice(0, 100)
                .map((p) => ({
                  label: text(p.label),
                  value: number(p.value),
                  valueLabel: text(p.valueLabel),
                }))
                .filter((p) => p.value !== undefined)
            : undefined,
        })),
      })),
    };
  }
  async function handle(request) {
    switch (request.action) {
      case "overview":
        return overview();
      case "start":
        await start();
        return overview();
      case "stop":
        await stop(request.interrupt);
        return overview();
      case "startup":
        await save({ ...state, startLocalAtLaunch: request.enabled });
        return overview();
      case "select":
        if (request.hostId !== "local") record(request.hostId);
        await save({ ...state, selectedHost: request.hostId });
        return overview();
      case "connect": {
        if (state.hosts.length >= 32)
          fail("HOST_CAPACITY", "Remove an unused host before adding another.");
        connectionTarget(request.invitation); // Validates TLS/loopback policy before the exchange.
        const hostId = randomUUID();
        const descriptor = await connectClient(
          request.invitation,
          profilePath(hostId),
        );
        try {
          await save({
            ...state,
            selectedHost: hostId,
            hosts: [
              ...state.hosts,
              {
                id: hostId,
                label: request.label,
                url: descriptor.url,
                expiresAt: descriptor.expiresAt,
              },
            ],
          });
        } catch {
          fail(
            "HOST_SAVE_FAILED",
            "The invitation was consumed and the profile saved, but the host list could not be updated. Reconcile the saved profile before pairing again.",
          );
        }
        return overview();
      }
      case "forget": {
        record(request.hostId);
        await save({
          ...state,
          selectedHost:
            state.selectedHost === request.hostId
              ? "local"
              : state.selectedHost,
          hosts: state.hosts.filter((h) => h.id !== request.hostId),
        });
        clients.delete(request.hostId);
        await rm(join(directory, "connections", request.hostId), {
          recursive: true,
          force: true,
        });
        return overview();
      }
      case "panel":
        if (["connect", "disconnect"].includes(request.request.action))
          fail(
            "INVALID_PANEL_REQUEST",
            "Use the desktop host connection controls.",
          );
        return panel(request.hostId)(request.request);
      case "connections":
        return (await client(request.hostId)).connections();
      case "invite": {
        const selected = connection(request.hostId);
        if (!selected.url)
          fail("HOST_STOPPED", "Start the host before creating an invitation.");
        const invitation = await (
          await client(request.hostId)
        ).createInvitation(request.input);
        return {
          invitation: connectionInvitation(selected.url, invitation.code),
          expiresAt: invitation.expiresAt,
          grant: invitation.grant,
        };
      }
      case "revoke":
        return (await client(request.hostId)).revokeConnection(
          request.connectionId,
        );
      case "usage":
        return usage();
      case "usage-settings": {
        new UsageStatClient({ url: request.url }); // Reuse the SDK secure transport validation.
        const normalized = new URL(request.url).href;
        let tokenFile =
          normalized === state.usage.url && !request.clearToken
            ? state.usage.tokenFile
            : undefined;
        const previous = state.usage.tokenFile;
        if (request.token) {
          tokenFile = `usage-${randomUUID()}.token`;
          await writeFile(join(directory, tokenFile), request.token + "\n", {
            mode: 0o600,
            flag: "wx",
          });
        }
        try {
          await save({ ...state, usage: { url: normalized, tokenFile } });
        } catch (error) {
          if (tokenFile && tokenFile !== previous)
            await rm(join(directory, tokenFile), { force: true });
          throw error;
        }
        if (previous && previous !== tokenFile)
          await rm(join(directory, previous), { force: true });
        metadata = [];
        return overview();
      }
    }
  }
  try {
    try {
      state = stateSchema.parse(
        JSON.parse(await secrets({ file: settingsPath })),
      );
    } catch (e) {
      // Missing settings is the only reason to create a new profile. Invalid/private files fail closed.
      try {
        await lstat(settingsPath);
      } catch (missing) {
        if (missing.code !== "ENOENT") throw missing;
        await save({
          version: 1,
          selectedHost: "local",
          startLocalAtLaunch: true,
          hosts: [],
          usage: { url: "http://127.0.0.1:6736/" },
        });
      }
      if (!state) throw e;
    }
    if (state.selectedHost !== "local") record(state.selectedHost);
    if (autoStart && state.startLocalAtLaunch) {
      try {
        await start();
      } catch (error) {
        startupError = publicError(error);
      }
    }
  } catch (error) {
    await lock.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  return {
    async request(input) {
      if (closed || closing)
        fail("DESKTOP_STOPPED", "The desktop is shutting down.");
      const parsed = RequestSchema.safeParse(input);
      if (!parsed.success)
        fail(
          "INVALID_DESKTOP_REQUEST",
          "Choose a supported desktop operation with valid fields.",
        );
      const req = parsed.data;
      if (
        req.action === "overview" ||
        req.action === "usage" ||
        req.action === "connections" ||
        (req.action === "panel" && req.request.action === "snapshot")
      )
        return handle(req);
      return serial(() => handle(req));
    },
    async close({ interrupt = false } = {}) {
      if (closed) return;
      closing = true;
      try {
        await queue;
        await stop(interrupt);
      } catch (e) {
        closing = false;
        throw e;
      }
      closed = true;
      await lock.close();
      await rm(lockPath, { force: true });
    },
  };
}
