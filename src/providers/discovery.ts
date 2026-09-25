import { z } from "zod";
import { readLimited, secureBaseUrl } from "../security.js";
import type { ProviderInspection } from "../types.js";
import type { ApiProviderOptions } from "./http.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/);
const dataPage = z.object({ data: z.array(z.object({ id })).max(10_000) });
const anthropicPage = dataPage.extend({
  has_more: z.boolean(),
  last_id: z.string().nullable().optional(),
});
const googlePage = z.object({
  models: z
    .array(
      z.object({
        name: id,
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .max(1000)
    .optional(),
  nextPageToken: z.string().max(4096).optional(),
});

/** Uses only the configured endpoint's GET catalog. No model calls, redirects or fallback accounts. */
export function apiInspection(
  options: ApiProviderOptions,
  defaultBase: string,
  auth: "bearer" | "anthropic" | "google",
) {
  const base = secureBaseUrl(options.baseUrl ?? defaultBase);
  return async ({
    signal,
  }: {
    signal: AbortSignal;
  }): Promise<ProviderInspection> => {
    const key =
      typeof options.apiKey === "function"
        ? await options.apiKey()
        : options.apiKey;
    signal.throwIfAborted();
    if (!key) return { code: "AUTH_REQUIRED" };
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (auth === "google") headers["x-goog-api-key"] = key;
    else {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
    const models = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined,
      bytes = 0;
    for (let page = 0; page < 20; page++) {
      signal.throwIfAborted();
      const url = new URL("models", base);
      if (auth === "google") {
        url.searchParams.set("pageSize", "100");
        if (cursor) url.searchParams.set("pageToken", cursor);
      }
      if (auth === "anthropic") {
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("after_id", cursor);
      }
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "GET",
          headers,
          signal,
          redirect: "error",
        });
      } catch {
        signal.throwIfAborted();
        return { code: "PROVIDER_UNREACHABLE" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          code:
            response.status === 401
              ? "AUTH_REJECTED"
              : response.status === 403
                ? "ACCESS_DENIED"
                : response.status === 429
                  ? "RATE_LIMITED"
                  : [404, 405].includes(response.status)
                    ? "DISCOVERY_UNSUPPORTED"
                    : "DISCOVERY_FAILED",
        };
      }
      try {
        const body = await readLimited(response, 2_000_000 - bytes);
        bytes += new TextEncoder().encode(body).byteLength;
        const raw: unknown = JSON.parse(body);
        let ids: string[], next: string | undefined;
        if (auth === "google") {
          const value = googlePage.parse(raw);
          ids = (value.models ?? []).map((model) =>
            model.name.replace(/^models\//, ""),
          );
          next = value.nextPageToken || undefined;
        } else if (auth === "anthropic") {
          const value = anthropicPage.parse(raw);
          ids = value.data.map((model) => model.id);
          if (value.has_more) {
            if (!value.last_id) return { code: "INVALID_DISCOVERY_RESPONSE" };
            next = value.last_id;
          }
        } else ids = dataPage.parse(raw).data.map((model) => model.id);
        for (const model of ids) {
          if (models.size === 1000 && !models.has(model))
            return {
              code: "CATALOG_AVAILABLE",
              models: [...models],
              complete: false,
            };
          models.add(model);
        }
        if (!next)
          return {
            code: "CATALOG_AVAILABLE",
            models: [...models],
            complete: true,
          };
        if (cursors.has(next)) return { code: "INVALID_DISCOVERY_RESPONSE" };
        cursors.add(next);
        cursor = next;
      } catch {
        signal.throwIfAborted();
        return { code: "INVALID_DISCOVERY_RESPONSE" };
      }
    }
    return { code: "CATALOG_AVAILABLE", models: [...models], complete: false };
  };
}
