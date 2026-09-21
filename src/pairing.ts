import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";

export interface PairingOptions {
  /** Better Auth base URL including /api/auth. HTTPS except explicit loopback development. */
  issuer: string;
  /** Register one public native OAuth client per device in the application. */
  clientId: string;
  resource: string;
  scopes: string[];
  fetch?: typeof globalThis.fetch;
  /** Deadline for a single auth HTTP exchange, never for an SDK run. */
  requestTimeoutMs?: number;
}
export interface PairingRequest {
  /** Keep private; only the user code and verification URL belong in UI. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
}
export interface PairingCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  tokenType: "Bearer";
}
const credential = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\s\0]+$/);
const duration = z.number().int().positive().max(31_536_000);
const deviceSchema = z.object({
  device_code: credential,
  user_code: z.string().min(1).max(128),
  verification_uri: z.url().max(4096),
  verification_uri_complete: z.url().max(4096).optional(),
  expires_in: duration,
  interval: z.number().int().positive().max(3600).default(5),
});
const tokenSchema = z.object({
  access_token: credential,
  refresh_token: credential.optional(),
  expires_in: duration,
  token_type: z.literal("Bearer"),
  scope: z.string().max(8192),
});
const errorSchema = z.object({ error: z.string() });
const unavailable = () =>
  new DriverError(
    "AUTH_UNAVAILABLE",
    "The application authentication service is unavailable. Check the connection before trying again.",
    true,
  );
const invalid = () =>
  new DriverError(
    "INVALID_AUTH_RESPONSE",
    "The application authentication response is invalid.",
  );

/** RFC 8628/6749 client for Better Auth's OAuth provider. No login UI or credential persistence. */
export class BetterAuthPairingClient {
  private readonly base: URL;
  private readonly clientId: string;
  private readonly resource: string;
  private readonly scopes: string[];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeout: number;
  private refreshing?: Promise<PairingCredentials>;
  constructor(options: PairingOptions) {
    this.base = secureBaseUrl(options.issuer);
    this.clientId = credential.parse(options.clientId);
    const resource = new URL(options.resource);
    if (resource.hash)
      throw new DriverError(
        "INVALID_AUTH_CONFIG",
        "OAuth resource identifiers cannot contain fragments.",
      );
    this.resource = options.resource;
    this.scopes = z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\s]+$/),
      )
      .min(1)
      .max(256)
      .parse([...new Set(options.scopes)]);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = options.requestTimeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60_000
    )
      throw new DriverError(
        "INVALID_AUTH_CONFIG",
        "The auth request timeout must be between 1 and 60000 milliseconds.",
      );
  }
  private async exchange(
    path: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeout),
    ]);
    try {
      const response = await abortable(
        this.fetcher(new URL(path, this.base), {
          method: "POST",
          body: new URLSearchParams(body),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: deadline,
        }),
        deadline,
      );
      if (response.status >= 500) {
        await response.body?.cancel();
        throw unavailable();
      }
      const text = await abortable(readLimited(response, 32_768), deadline);
      return {
        ok: response.ok,
        value: text ? (JSON.parse(text) as unknown) : null,
      };
    } catch {
      if (signal?.aborted) throw signal.reason;
      // Never expose server response bodies, device codes or tokens through errors.
      throw unavailable();
    }
  }
  private failure(value: unknown): never {
    const parsed = errorSchema.safeParse(value);
    switch (parsed.success ? parsed.data.error : undefined) {
      case "access_denied":
        throw new DriverError(
          "PAIRING_DENIED",
          "The user denied this device request.",
        );
      case "expired_token":
        throw new DriverError(
          "PAIRING_EXPIRED",
          "The device request expired. Start a new pairing request.",
        );
      case "invalid_grant":
        throw new DriverError(
          "AUTH_REQUIRED",
          "This credential is no longer valid. Reconnect through the application's authentication flow.",
        );
      default:
        throw new DriverError(
          "AUTH_REJECTED",
          "The application rejected this authentication request.",
        );
    }
  }
  private credentials(value: unknown, startedAt: number): PairingCredentials {
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success || parsed.data.access_token.includes("."))
      throw invalid();
    const scopes = [...new Set(parsed.data.scope.split(/\s+/).filter(Boolean))];
    if (scopes.some((scope) => !this.scopes.includes(scope))) throw invalid();
    return {
      accessToken: parsed.data.access_token,
      ...(parsed.data.refresh_token
        ? { refreshToken: parsed.data.refresh_token }
        : {}),
      expiresAt: startedAt + parsed.data.expires_in * 1000,
      scopes,
      tokenType: "Bearer",
    };
  }
  async start(signal?: AbortSignal): Promise<PairingRequest> {
    const startedAt = Date.now();
    const { ok, value } = await this.exchange(
      "device/code",
      {
        client_id: this.clientId,
        resource: this.resource,
        scope: this.scopes.join(" "),
      },
      signal,
    );
    if (!ok) this.failure(value);
    const parsed = deviceSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const data = parsed.data;
    for (const url of [
      data.verification_uri,
      data.verification_uri_complete,
    ].filter((url): url is string => url !== undefined)) {
      const verification = new URL(url);
      if (
        verification.origin !== this.base.origin ||
        verification.username ||
        verification.password ||
        verification.hash
      )
        throw invalid();
    }
    if (
      data.verification_uri_complete &&
      new URL(data.verification_uri_complete).pathname !==
        new URL(data.verification_uri).pathname
    )
      throw invalid();
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      ...(data.verification_uri_complete
        ? { verificationUriComplete: data.verification_uri_complete }
        : {}),
      expiresAt: startedAt + data.expires_in * 1000,
      intervalMs: data.interval * 1000,
    };
  }
  /** Display userCode and verificationUri; this method never approves or opens a browser automatically. */
  async wait(
    request: PairingRequest,
    signal?: AbortSignal,
  ): Promise<PairingCredentials> {
    credential.parse(request.deviceCode);
    if (
      !Number.isSafeInteger(request.intervalMs) ||
      request.intervalMs < 1000 ||
      request.intervalMs > 3_600_000 ||
      !Number.isFinite(request.expiresAt)
    )
      throw invalid();
    let interval = request.intervalMs;
    const expiry = new DriverError(
      "PAIRING_EXPIRED",
      "The device request expired. Start a new pairing request.",
    );
    while (true) {
      signal?.throwIfAborted();
      const remaining = request.expiresAt - Date.now();
      if (remaining <= 0) throw expiry;
      await pause(Math.min(interval, remaining), signal);
      if (Date.now() >= request.expiresAt) throw expiry;
      const startedAt = Date.now();
      const { ok, value } = await this.exchange(
        "oauth2/token",
        {
          client_id: this.clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: request.deviceCode,
          resource: this.resource,
        },
        signal,
      );
      if (ok) return this.credentials(value, startedAt);
      const error = errorSchema.safeParse(value);
      if (error.success && error.data.error === "authorization_pending")
        continue;
      if (error.success && error.data.error === "slow_down") {
        interval += 5000;
        continue;
      }
      this.failure(value);
    }
  }
  /** Refresh exactly once; never retry an uncertain rotation. Persist its result atomically in the app's secret store. */
  async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<PairingCredentials> {
    if (this.refreshing)
      throw new DriverError(
        "AUTH_REFRESH_IN_PROGRESS",
        "A credential refresh is already in progress for this device.",
      );
    credential.parse(refreshToken);
    const startedAt = Date.now();
    const pending = (async () => {
      const { ok, value } = await this.exchange(
        "oauth2/token",
        {
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource: this.resource,
        },
        signal,
      );
      if (!ok) this.failure(value);
      return this.credentials(value, startedAt);
    })();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      this.refreshing = undefined;
    }
  }
  async revoke(
    token: string,
    kind: "access_token" | "refresh_token",
    signal?: AbortSignal,
  ): Promise<void> {
    credential.parse(token);
    const { ok, value } = await this.exchange(
      "oauth2/revoke",
      { client_id: this.clientId, token, token_type_hint: kind },
      signal,
    );
    if (!ok) this.failure(value);
  }
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
