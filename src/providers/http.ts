import { z } from "zod";
import { DriverError } from "../errors.js";
import { readLimited, secureBaseUrl } from "../security.js";
import { readSse } from "../client.js";
import { fetchWithSafeRetries } from "./retry.js";
import type {
  JsonObject,
  ProviderInfo,
  ProviderContext,
  RetryPolicy,
} from "../types.js";

export interface ApiProviderOptions {
  apiKey: string | (() => string | Promise<string>);
  id?: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
  fetch?: typeof globalThis.fetch;
}
export function apiInfo(
  vendor: string,
  name: string,
  options: ApiProviderOptions,
  usageStatId: string,
): ProviderInfo {
  return {
    id: options.id ?? vendor,
    name: options.name ?? name,
    vendor,
    authMode: "api-key",
    capabilities: { tools: true, textStreaming: true, safeRetries: true },
    models: options.models,
    usageStatId,
  };
}
export function streamTransport(
  options: ApiProviderOptions,
  defaultBase: string,
  auth: "bearer" | "anthropic" | "google",
) {
  const base = secureBaseUrl(options.baseUrl ?? defaultBase);
  return async (
    path: string,
    body: unknown,
    context: ProviderContext,
    collect: (
      events: AsyncIterable<unknown>,
      context: ProviderContext,
    ) => Promise<unknown>,
    retry?: RetryPolicy,
  ): Promise<unknown> => {
    const { signal } = context;
    const key =
      typeof options.apiKey === "function"
        ? await options.apiKey()
        : options.apiKey;
    if (!key)
      throw new DriverError(
        "AUTH_REQUIRED",
        "Configure an API key on the execution host.",
      );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (auth === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (auth === "google") headers["x-goog-api-key"] = key;
    else {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
    let response: Response;
    try {
      response = await fetchWithSafeRetries(
        options.fetch ?? globalThis.fetch,
        new URL(path, base),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        },
        retry,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DriverError(
        "PROVIDER_UNREACHABLE",
        "Could not reach the provider.",
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code =
        response.status === 401 || response.status === 403
          ? "PROVIDER_AUTH"
          : response.status === 429
            ? "RATE_LIMITED"
            : "PROVIDER_ERROR";
      throw new DriverError(
        code,
        `The provider returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (
      response.headers.get("content-type")?.includes("text/event-stream") &&
      response.body
    ) {
      return collect(providerEvents(response.body), context);
    }
    try {
      return JSON.parse(await readLimited(response));
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned invalid JSON.",
      );
    }
  };
}

async function* providerEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  let bytes = 0;
  for await (const data of readSse(body)) {
    bytes += new TextEncoder().encode(data).byteLength;
    if (bytes > 10_000_000)
      throw new DriverError(
        "RESPONSE_TOO_LARGE",
        "The provider response exceeded the size limit.",
      );
    if (data === "[DONE]") {
      yield data;
      return;
    }
    try {
      yield JSON.parse(data) as unknown;
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider stream contained invalid JSON.",
      );
    }
  }
}
export const tokenCount = z.number().finite().nonnegative().optional();
export function toolArguments(value: string | unknown): JsonObject {
  try {
    const parsed: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    return z.record(z.string(), z.json()).parse(parsed) as JsonObject;
  } catch {
    throw new DriverError(
      "INVALID_TOOL_ARGUMENTS",
      "The provider returned malformed tool arguments.",
    );
  }
}
export function parseWire<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DriverError(
      "INVALID_PROVIDER_RESPONSE",
      "The provider response did not match its documented format.",
    );
  return result.data;
}
