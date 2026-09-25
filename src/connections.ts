import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  authenticatedPrincipal,
  accessPolicy,
  type AuthenticatedPrincipal,
} from "./authorization.js";
import {
  ConnectionInfoSchema,
  CreateInvitationSchema,
  RevokeConnectionSchema,
  type ConnectionCredentials,
  type ConnectionInvitation,
  type ConnectionList,
} from "./connection-types.js";
import { DriverError } from "./errors.js";
import type { ServerOptions } from "./server.js";
export * from "./connection-types.js";

const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const matches = (value: string, hash: string) =>
  timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"));
const RecordSchema = ConnectionInfoSchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  lifetime: z.number().int().min(60).max(7_776_000).optional(),
});
const StateSchema = z
  .object({
    version: z.literal(1),
    invitations: z.array(RecordSchema).max(1000),
    connections: z.array(RecordSchema).max(1000),
  })
  .strict();
type State = z.infer<typeof StateSchema>;
const publicInfo = ({
  digest: _digest,
  lifetime: _lifetime,
  ...info
}: z.infer<typeof RecordSchema>) => info;
export interface HostConnections {
  create(input: unknown): Promise<ConnectionInvitation>;
  exchange(code: string): Promise<ConnectionCredentials>;
  list(): Promise<ConnectionList>;
  revoke(input: unknown): Promise<{ revoked: boolean }>;
  authenticate(token: string): Promise<AuthenticatedPrincipal | undefined>;
  resolve(id: string): Promise<AuthenticatedPrincipal | undefined>;
}

/** Private transport grants. These records contain no provider credentials or application identities. */
export async function hostConnections(
  file: string,
  options: { providers(): readonly string[]; now?: () => number },
): Promise<HostConnections> {
  const path = resolve(file),
    now = options.now ?? Date.now;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  async function read(): Promise<State> {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 1_000_000 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error();
      const buffer = Buffer.alloc(1_000_001);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 1_000_000) throw new Error();
      return StateSchema.parse(
        JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(
            buffer.subarray(0, size),
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, invitations: [], connections: [] };
      throw new DriverError(
        "CONNECTION_STORE_UNAVAILABLE",
        "The private connection store could not be read.",
      );
    } finally {
      await handle?.close();
    }
  }
  const current = (state: State) => {
    state.invitations = state.invitations.filter(
      (i) => Date.parse(i.expiresAt) > now(),
    );
    state.connections = state.connections.filter(
      (i) => Date.parse(i.expiresAt) > now(),
    );
    return state;
  };
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (state: State) => T): Promise<T> {
    const pending = queue.then(async () => {
      let lock;
      try {
        lock = await open(path + ".lock", "wx", 0o600);
      } catch {
        throw new DriverError(
          "CONNECTION_STORE_BUSY",
          "Another connection writer holds the store lock.",
          true,
        );
      }
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        const state = current(await read());
        const result = fn(state);
        const body = JSON.stringify(StateSchema.parse(state)) + "\n";
        if (Buffer.byteLength(body) > 1_000_000)
          throw new DriverError(
            "CONNECTION_CAPACITY",
            "Revoke unused connections before creating another.",
          );
        const output = await open(temporary, "wx", 0o600);
        try {
          await output.writeFile(body);
          await output.sync();
        } finally {
          await output.close();
        }
        await rename(temporary, path);
        return result;
      } catch (error) {
        if (error instanceof DriverError) throw error;
        throw new DriverError(
          "CONNECTION_STORE_UNAVAILABLE",
          "The connection change could not be saved. Reconcile before retrying.",
        );
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
        await lock.close();
        await rm(path + ".lock", { force: true });
      }
    });
    queue = pending.catch(() => {});
    return pending;
  }
  await read();
  return {
    create: (input) =>
      mutate((state) => {
        const parsed = CreateInvitationSchema.safeParse(input);
        if (!parsed.success)
          throw new DriverError(
            "INVALID_INVITATION",
            "Select a bounded invitation lifetime and explicit connection grant.",
          );
        const { grant, expiresInSeconds, connectionLifetimeSeconds } =
          parsed.data;
        if (grant.providers.some((id) => !options.providers().includes(id)))
          throw new DriverError(
            "INVALID_INVITATION",
            "A connection grant references an unconfigured provider.",
          );
        if (state.invitations.length >= 1000)
          throw new DriverError(
            "CONNECTION_CAPACITY",
            "Revoke unused invitations before creating another.",
          );
        const code = randomBytes(32).toString("base64url");
        const record = {
          id: randomUUID(),
          grant,
          createdAt: new Date(now()).toISOString(),
          expiresAt: new Date(now() + expiresInSeconds * 1000).toISOString(),
          digest: digest(code),
          lifetime: connectionLifetimeSeconds,
        };
        state.invitations.push(record);
        return { ...publicInfo(record), code };
      }),
    exchange: (code) =>
      mutate((state) => {
        const index = /^[A-Za-z0-9_-]{43}$/.test(code)
          ? state.invitations.findIndex((i) => matches(code, i.digest))
          : -1;
        if (index < 0)
          throw new DriverError(
            "INVITATION_REJECTED",
            "The invitation expired, was already used, or is invalid. Create a new invitation on the host.",
          );
        if (state.connections.length >= 1000)
          throw new DriverError(
            "CONNECTION_CAPACITY",
            "Revoke unused connections before pairing another.",
          );
        const invitation = state.invitations[index]!;
        const token = randomBytes(32).toString("base64url");
        const record = {
          id: randomUUID(),
          grant: invitation.grant,
          createdAt: new Date(now()).toISOString(),
          expiresAt: new Date(
            now() + invitation.lifetime! * 1000,
          ).toISOString(),
          digest: digest(token),
        };
        state.invitations.splice(index, 1);
        state.connections.push(record);
        return { ...publicInfo(record), token };
      }),
    list: async () => {
      const state = current(await read());
      return {
        invitations: state.invitations.map(publicInfo),
        connections: state.connections.map(publicInfo),
      };
    },
    revoke: (input) =>
      mutate((state) => {
        const parsed = RevokeConnectionSchema.safeParse(input);
        if (!parsed.success)
          throw new DriverError(
            "INVALID_INVITATION",
            "Use an explicit connection or invitation ID.",
          );
        const count = state.connections.length + state.invitations.length;
        state.connections = state.connections.filter(
          (c) => c.id !== parsed.data.id,
        );
        state.invitations = state.invitations.filter(
          (c) => c.id !== parsed.data.id,
        );
        return {
          revoked:
            count !== state.connections.length + state.invitations.length,
        };
      }),
    authenticate: async (token) => {
      const match = current(await read()).connections.find((c) =>
        matches(token, c.digest),
      );
      return match
        ? authenticatedPrincipal({
            ...match.grant,
            id: `connection:${match.id}`,
          })
        : undefined;
    },
    resolve: async (id) => {
      const match = current(await read()).connections.find(
        (c) => `connection:${c.id}` === id,
      );
      return match ? authenticatedPrincipal({ ...match.grant, id }) : undefined;
    },
  };
}

/** Add paired transport credentials alongside the host's existing authentication contract. */
export function withConnections(
  options: ServerOptions,
  connections: HostConnections,
): ServerOptions {
  if (
    options.jobs &&
    options.authentication &&
    !options.authentication.resolveJobPrincipal
  )
    throw new DriverError(
      "INVALID_AUTH_POLICY",
      "Application authentication requires a durable principal resolver for jobs.",
    );
  const entries = (options.tokens ?? []).map((entry) => ({
    ...accessPolicy(entry),
    id: digest(entry.token),
    digest: digest(entry.token),
  }));
  if (
    entries.some((e) => !e.subject) ||
    (options.tokens ?? []).some((e) => e.token.length < 32) ||
    new Set(entries.map((e) => e.digest)).size !== entries.length
  )
    throw new DriverError(
      "INVALID_AUTH_POLICY",
      "Static credentials must be distinct and contain at least 32 characters.",
    );
  if (Boolean(entries.length) === Boolean(options.authentication))
    throw new DriverError(
      "INVALID_AUTH_POLICY",
      "Supply static credentials or application-owned authentication.",
    );
  return {
    ...options,
    tokens: undefined,
    connections,
    authentication: {
      authenticate: async (token, signal) =>
        (options.authentication
          ? await options.authentication.authenticate(token, signal)
          : entries.find((e) => matches(token, e.digest))) ??
        (await connections.authenticate(token)),
      resolveJobPrincipal: async (id, signal) =>
        (options.authentication?.resolveJobPrincipal
          ? await options.authentication.resolveJobPrincipal(id, signal)
          : entries.find((e) => e.id === id)) ??
        (await connections.resolve(id)),
    },
  };
}

export {
  connectClient,
  connectedClient,
  type ConnectionProfile,
} from "./connection-profile.js";
