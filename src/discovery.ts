import { z } from "zod";
import { abortable } from "./errors.js";
import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderInfo,
  ProviderInspectionCode,
} from "./types.js";

export interface DiscoveryOptions {
  /** Cached health and model inventory lifetime. Default: 30 seconds. */
  cacheTtlMs?: number;
  /** Bounds a discovery probe, never a model run. Default: 5 seconds. */
  timeoutMs?: number;
  /** Minimum interval even for explicit refresh. Default: 1 second. */
  minRefreshMs?: number;
}
const messages: Record<
  ProviderInspectionCode,
  [ProviderHealth["status"], string]
> = {
  CATALOG_AVAILABLE: [
    "ready",
    "The catalog is reachable. Model execution and quota have not been tested.",
  ],
  AUTH_REQUIRED: [
    "unauthenticated",
    "Configure an API key on the execution host.",
  ],
  AUTH_REJECTED: [
    "unauthenticated",
    "The provider rejected the credential. Replace or renew it on the execution host.",
  ],
  ACCESS_DENIED: [
    "unsupported",
    "Catalog access was denied. Check the credential's permissions and account configuration.",
  ],
  RATE_LIMITED: [
    "unavailable",
    "The provider limited catalog requests. Wait before refreshing.",
  ],
  PROVIDER_UNREACHABLE: [
    "unavailable",
    "Could not reach the provider. Check the host's network and endpoint configuration.",
  ],
  DISCOVERY_UNSUPPORTED: [
    "unsupported",
    "This adapter or endpoint has no supported catalog probe. Configure explicit model IDs on the host.",
  ],
  INVALID_DISCOVERY_RESPONSE: [
    "unavailable",
    "The catalog response was invalid. Check endpoint compatibility on the host.",
  ],
  CLI_UNAVAILABLE: [
    "unavailable",
    "The CLI executable could not be started. Install it or correct its host-configured path.",
  ],
  CLI_UPGRADE_REQUIRED: [
    "unsupported",
    "Upgrade the CLI to a version with the required restricted execution features.",
  ],
  CLI_SESSION_PRESENT: [
    "unknown",
    "The CLI reports a saved login. Credential freshness, model access and quota have not been verified.",
  ],
  CLI_CATALOG_AVAILABLE: [
    "unknown",
    "The signed-in CLI supplied a model catalog, which may include cached or bundled entries. Account entitlement, model execution and quota have not been verified.",
  ],
  CLI_AUTH_REQUIRED: [
    "unauthenticated",
    "The CLI reports no login. Sign in using the official CLI in this instance's account directory.",
  ],
  CLI_STATUS_UNKNOWN: [
    "unknown",
    "CLI execution features are available; a non-generation authentication check is unavailable or inconclusive.",
  ],
  DISCOVERY_TIMEOUT: [
    "unavailable",
    "The discovery check timed out. Check the host's network or CLI installation and refresh.",
  ],
  DISCOVERY_FAILED: [
    "unavailable",
    "The discovery check failed. Check the provider configuration on the execution host.",
  ],
};
const inspectionSchema = z
  .object({
    code: z.enum(
      Object.keys(messages) as [
        ProviderInspectionCode,
        ...ProviderInspectionCode[],
      ],
    ),
    models: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/))
      .max(1000)
      .optional(),
    complete: z.boolean().optional(),
  })
  .refine(
    (value) =>
      !["CATALOG_AVAILABLE", "CLI_CATALOG_AVAILABLE"].includes(value.code) ||
      value.models !== undefined,
  );
type Snapshot = Pick<ProviderInfo, "health" | "modelCatalog">;

/** One cache per driver and instance. Callers must filter authorization before invoking it. */
export class ProviderDiscovery {
  private readonly cache = new WeakMap<
    ProviderAdapter,
    { at: number; value: Snapshot }
  >();
  private readonly pending = new WeakMap<ProviderAdapter, Promise<Snapshot>>();
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly minimum: number;
  constructor(options: DiscoveryOptions = {}) {
    this.ttl = options.cacheTtlMs ?? 30_000;
    this.timeout = options.timeoutMs ?? 5000;
    this.minimum = options.minRefreshMs ?? 1000;
    for (const value of [this.ttl, this.timeout, this.minimum])
      if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
        throw new Error(
          "Discovery intervals must be nonnegative timer-sized integers.",
        );
    if (!this.timeout) throw new Error("Discovery timeout must be positive.");
  }

  async get(
    provider: ProviderAdapter,
    refresh: boolean,
  ): Promise<ProviderInfo> {
    const cached = this.cache.get(provider);
    const age = cached ? Date.now() - cached.at : Infinity;
    let snapshot: Snapshot;
    if (cached && age < Math.max(refresh ? 0 : this.ttl, this.minimum))
      snapshot = cached.value;
    else {
      let pending = this.pending.get(provider);
      if (!pending) {
        pending = this.probe(provider)
          .then((value) => {
            this.cache.set(provider, { at: Date.now(), value });
            return value;
          })
          .finally(() => this.pending.delete(provider));
        this.pending.set(provider, pending);
      }
      snapshot = await pending;
    }
    return structuredClone({ ...provider.info, ...snapshot });
  }

  private async probe(provider: ProviderAdapter): Promise<Snapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const raw = provider.inspect
        ? await abortable(
            Promise.resolve().then(() =>
              provider.inspect!({ signal: controller.signal }),
            ),
            controller.signal,
          )
        : { code: "DISCOVERY_UNSUPPORTED" };
      const parsed = inspectionSchema.safeParse(raw);
      const result = parsed.success
        ? parsed.data
        : { code: "INVALID_DISCOVERY_RESPONSE" as const };
      const [status, message] = messages[result.code];
      return {
        health: {
          status,
          code: result.code,
          message,
          checkedAt: new Date().toISOString(),
        },
        modelCatalog:
          (result.code === "CATALOG_AVAILABLE" ||
            result.code === "CLI_CATALOG_AVAILABLE") &&
          result.models
            ? {
                source: "provider",
                // Inventory is metadata, never an execution grant. The separate
                // provider.models allowlist still gates every run in the driver.
                models: [...new Set(result.models)],
                complete: result.complete ?? false,
              }
            : {
                source: provider.info.models ? "configured" : "unavailable",
                models: provider.info.models?.slice(0, 1000) ?? [],
                complete: false,
              },
      };
    } catch {
      const code = controller.signal.aborted
        ? "DISCOVERY_TIMEOUT"
        : "DISCOVERY_FAILED";
      const [status, message] = messages[code];
      return {
        health: { status, code, message, checkedAt: new Date().toISOString() },
        modelCatalog: {
          source: provider.info.models ? "configured" : "unavailable",
          models: provider.info.models?.slice(0, 1000) ?? [],
          complete: false,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
