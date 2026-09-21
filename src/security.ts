import { DriverError } from "./errors.js";

export function isLoopback(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    host.toLowerCase(),
  );
}

/** No redirects or URL credentials: neither may silently move a bearer/API key. */
export function secureBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DriverError(
      "INSECURE_TRANSPORT",
      "The driver URL must be an absolute HTTPS or loopback HTTP URL.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new DriverError(
      "INSECURE_TRANSPORT",
      "Use HTTPS, or HTTP on a loopback address, without URL credentials, query, or fragment.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export async function readLimited(
  response: Response,
  maxBytes = 2_000_000,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        try {
          return text + decoder.decode();
        } catch {
          throw new DriverError(
            "INVALID_RESPONSE",
            "The response is not valid UTF-8.",
          );
        }
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new DriverError(
          "RESPONSE_TOO_LARGE",
          "The response exceeded the size limit.",
        );
      try {
        text += decoder.decode(next.value, { stream: true });
      } catch {
        throw new DriverError(
          "INVALID_RESPONSE",
          "The response is not valid UTF-8.",
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
