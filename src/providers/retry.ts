import { setTimeout as delay } from "node:timers/promises";
import type { RetryPolicy } from "../types.js";

/** Returns undefined when another attempt is forbidden. Never shortens a provider's hint. */
export function retryDelay(
  headers: Headers,
  attempt: number,
  policy?: RetryPolicy,
): number | undefined {
  if (!policy || attempt >= policy.maxAttempts) return undefined;
  const raw = headers.get("retry-after")?.trim() ?? null;
  let hint = 0;
  if (raw !== null) {
    if (/^\d+(?:\.\d+)?$/.test(raw.trim())) hint = Number(raw) * 1000;
    else {
      const date = Date.parse(raw);
      if (!Number.isFinite(date) || new Date(date).toUTCString() !== raw)
        return undefined;
      hint = Math.max(0, date - Date.now());
    }
  }
  const wait = Math.max(hint, (policy.baseDelayMs ?? 500) * 2 ** (attempt - 1));
  if (!Number.isFinite(wait) || wait > (policy.maxDelayMs ?? 30_000))
    return undefined;
  return Math.ceil(wait);
}

/** A 429 response before streaming is a rejected request. Ambiguous network/5xx failures are never replayed. */
export async function fetchWithSafeRetries(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
  policy?: RetryPolicy,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    init.signal.throwIfAborted();
    const response = await fetcher(url, init);
    if (response.status !== 429) return response;
    const wait = retryDelay(response.headers, attempt, policy);
    if (wait === undefined) return response;
    await response.body?.cancel();
    // Waiting for quota is not model/tool progress and does not reset the run's idle timer.
    await delay(wait, undefined, { signal: init.signal });
  }
}
