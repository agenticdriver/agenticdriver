import { z } from "zod";
import {
  accessPolicy,
  type AccessPolicy,
  type HostAuthentication,
} from "./authorization.js";
import { abortable, DriverError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";

export type BetterAuthPermissions = Omit<AccessPolicy, "subject">;
export interface BetterAuthIdentity {
  issuer: string;
  clientId: string;
  /** Missing only for a separately registered service client. Never substitute its owner. */
  userId?: string;
}
export interface BetterAuthGrant {
  /** Stable app-owned authorization ID, never a credential. Use a distinct grant per device. */
  id: string;
  /** Canonical application/usage identity. It must not change when tokens rotate. */
  subject: string;
  /** Currently enabled OAuth scopes, intersected with this token's consented scopes. */
  scopes: string[];
}
export interface BetterAuthAuthenticationOptions {
  /** Exact Better Auth issuer including its base path, for example https://app.example/api/auth. */
  issuer: string;
  /** Exact OAuth resource identifier configured in Better Auth. */
  resource: string;
  /** Confidential resource-server client linked to this resource in Better Auth. */
  clientId: string;
  clientSecret(signal: AbortSignal): string | Promise<string>;
  /** Resolve current app authorization from the verified client/user tuple. Unknown tuples must deny. */
  resolveGrant(
    identity: BetterAuthIdentity,
    signal: AbortSignal,
  ): Promise<BetterAuthGrant | undefined>;
  /** Explicit scopes for concrete providers, tools and corpora; no wildcard grants. */
  scopes: Record<string, BetterAuthPermissions>;
  /** Optional app-owned durable job grant resolver. It must enforce the admitted scope ceiling. */
  resolveJobPrincipal?: HostAuthentication["resolveJobPrincipal"];
  /** Use a Fetch wrapper around auth.handler for an in-process Better Auth application. */
  fetch?: typeof globalThis.fetch;
  /** Bounds an auth request, never model execution. Default 5 seconds. */
  requestTimeoutMs?: number;
}
const activeToken = z.object({
  active: z.literal(true),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1).max(16)]),
  client_id: z.string().min(1).max(256),
  sub: z.string().min(1).max(256).optional(),
  exp: z.number().int().positive(),
  scope: z.string().max(8192),
  token_type: z.literal("Bearer"),
  // Sender-constrained tokens require proof verification; this integration accepts bearer tokens only.
  cnf: z.never().optional(),
});
const grantSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/),
  subject: z.string().min(1).max(128),
  scopes: z.array(z.string().min(1).max(256)).max(256),
});
const unavailable = () =>
  new DriverError(
    "AUTH_UNAVAILABLE",
    "The application authentication service is unavailable.",
    true,
  );

/** Better Auth 1.7.3 OAuth introspection. Pair its runtime with the supported AuthYard connector. */
export function betterAuthAuthentication(
  options: BetterAuthAuthenticationOptions,
): HostAuthentication {
  const base = secureBaseUrl(options.issuer);
  const issuer = options.issuer.replace(/\/$/, "");
  // A resource is an exact RFC 8707 URI, not a fetch target.
  const resource = new URL(options.resource);
  if (resource.hash || !options.clientId || /[\r\n\0]/.test(options.clientId))
    throw new DriverError(
      "INVALID_AUTH_CONFIG",
      "Configure an explicit OAuth resource and resource-server client.",
    );
  const timeout = options.requestTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new DriverError(
      "INVALID_AUTH_CONFIG",
      "The authentication request timeout must be between 1 and 60000 milliseconds.",
    );
  const policies = new Map(
    Object.entries(options.scopes).map(([scope, permissions]) => {
      if (!scope || /\s/.test(scope) || scope.length > 256)
        throw new DriverError(
          "INVALID_AUTH_CONFIG",
          "OAuth scope names must be bounded non-whitespace strings.",
        );
      return [scope, accessPolicy({ ...permissions, subject: "validation" })];
    }),
  );
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    resolveJobPrincipal: options.resolveJobPrincipal,
    async authenticate(token, callerSignal) {
      // Opaque tokens have immediate native revocation. JWT revocation is not equivalent.
      if (!token || token.length > 4096 || /[\s.\0]/.test(token))
        return undefined;
      const signal = AbortSignal.any([
        callerSignal,
        AbortSignal.timeout(timeout),
      ]);
      let payload: unknown;
      try {
        const secret = await abortable(
          Promise.resolve(options.clientSecret(signal)),
          signal,
        );
        if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret))
          throw unavailable();
        const body = new URLSearchParams({
          token,
          token_type_hint: "access_token",
        });
        const credential = Buffer.from(
          `${encodeURIComponent(options.clientId)}:${encodeURIComponent(secret)}`,
        ).toString("base64");
        const response = await abortable(
          fetcher(new URL("oauth2/introspect", base), {
            method: "POST",
            headers: {
              Authorization: `Basic ${credential}`,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body,
            signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
          }),
          signal,
        );
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        ) {
          await response.body?.cancel();
          throw unavailable();
        }
        payload = JSON.parse(
          await abortable(readLimited(response, 32_768), signal),
        );
      } catch {
        if (callerSignal.aborted) throw callerSignal.reason;
        throw unavailable();
      }
      const parsed = activeToken.safeParse(payload);
      if (!parsed.success) return undefined;
      const claims = parsed.data;
      if (
        claims.iss !== issuer ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(
          options.resource,
        ) ||
        claims.exp * 1000 <= Date.now()
      )
        return undefined;
      let grant: BetterAuthGrant | undefined;
      try {
        grant = await abortable(
          options.resolveGrant(
            {
              issuer,
              clientId: claims.client_id,
              ...(claims.sub ? { userId: claims.sub } : {}),
            },
            signal,
          ),
          signal,
        );
      } catch {
        if (callerSignal.aborted) throw callerSignal.reason;
        throw unavailable();
      }
      if (!grant) return undefined;
      if (claims.exp * 1000 <= Date.now()) return undefined;
      const current = grantSchema.safeParse(grant);
      if (!current.success)
        throw new DriverError(
          "INVALID_AUTH_POLICY",
          "The application returned an invalid authorization grant.",
        );
      const permitted = new Set(current.data.scopes);
      const selected = [...new Set(claims.scope.split(/\s+/))]
        .filter((scope) => permitted.has(scope))
        .flatMap((scope) =>
          policies.has(scope) ? [policies.get(scope)!] : [],
        );
      if (!selected.length) return undefined;
      const policy = accessPolicy({
        subject: current.data.subject,
        providers: [],
      });
      for (const next of selected) {
        for (const field of [
          "providers",
          "tools",
          "approveTools",
          "jobs",
          "sessions",
        ] as const)
          (policy[field] as string[]).push(...next[field]);
        for (const operation of ["search", "index", "delete"] as const)
          policy.retrieval[operation].push(...next.retrieval[operation]);
        for (const tool of next.applicationTools) {
          const prior = policy.applicationTools.find(
            (entry) => entry.name === tool.name,
          );
          if (prior)
            prior.requiresApproval =
              prior.requiresApproval !== false ||
              tool.requiresApproval !== false;
          else policy.applicationTools.push({ ...tool });
        }
      }
      for (const field of [
        "providers",
        "tools",
        "approveTools",
        "jobs",
        "sessions",
      ] as const)
        Object.assign(policy, { [field]: [...new Set(policy[field])] });
      for (const operation of ["search", "index", "delete"] as const)
        policy.retrieval[operation] = [...new Set(policy.retrieval[operation])];
      return { ...accessPolicy(policy), id: current.data.id };
    },
  };
}
