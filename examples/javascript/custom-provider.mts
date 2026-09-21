/** Independent adapter: public package imports only, no SDK source dependencies. */
import { DriverError } from "@agenticdriver/sdk";
import {
  defineProviderExtension,
  providerEndpoint,
  readProviderResponse,
  type ProviderTurn,
} from "@agenticdriver/sdk/provider-kit";

// Example enterprise protocol: GET models; POST complete returns bounded NDJSON.
// Replace this module with your own endpoint's translation, keeping the contract.
export const customProvider = defineProviderExtension(
  {
    id: "example-ndjson",
    name: "Example enterprise adapter",
    version: "1.0.0",
    contractVersion: "1.0",
    vendor: "example",
    authMode: "api-key",
    usageSource: "adapter-report",
    capabilities: {
      tools: true,
      textStreaming: true,
      historyContinuation: true,
      nativeContinuation: true,
    },
  },
  (options) => {
    const configured = options.settings?.endpoint;
    if (typeof configured !== "string")
      throw new DriverError(
        "INVALID_PROVIDER_EXTENSION",
        "Configure an explicit provider endpoint on the host.",
      );
    const endpoint = providerEndpoint(configured); // Validate before reading a credential.
    async function request(
      path: "models" | "complete",
      signal: AbortSignal,
      body?: unknown,
    ) {
      const secret = await options.getSecret?.("apiKey", signal);
      if (!secret || /[\r\n]/.test(secret))
        throw new DriverError(
          "AUTH_REQUIRED",
          "Configure the extension credential on the host.",
        );
      signal.throwIfAborted();
      const response = await fetch(new URL(path, endpoint), {
        method: body === undefined ? "GET" : "POST",
        signal,
        redirect: "error",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Never echo a provider response, URL or credential in a public DriverError.
        throw new DriverError(
          response.status === 401
            ? "AUTH_REJECTED"
            : response.status === 403
              ? "ACCESS_DENIED"
              : response.status === 429
                ? "RATE_LIMITED"
                : "PROVIDER_ERROR",
          "The configured endpoint rejected the operation.",
        );
      }
      return response;
    }
    return {
      async inspect({ signal }) {
        const data: unknown = JSON.parse(
          await readProviderResponse(await request("models", signal), 128_000),
        );
        if (
          !Array.isArray(data) ||
          data.length > 1000 ||
          !data.every((model) => typeof model === "string")
        )
          return { code: "INVALID_DISCOVERY_RESPONSE" };
        return { code: "CATALOG_AVAILABLE", models: data, complete: true };
      },
      async complete(input, context) {
        const response = await request("complete", context.signal, input);
        if (
          !response.body ||
          response.headers.get("content-type")?.split(";")[0] !==
            "application/x-ndjson"
        ) {
          await response.body?.cancel();
          throw new DriverError(
            "INVALID_PROVIDER_RESULT",
            "The endpoint must return an NDJSON stream.",
          );
        }
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          pending = "",
          turn: ProviderTurn | undefined;
        function consume(line: string) {
          if (!line.trim()) return;
          const frame = JSON.parse(line) as {
            type?: unknown;
            text?: unknown;
            turn?: unknown;
          };
          if (turn) throw new Error("Frames after terminal result");
          if (frame?.type === "text" && typeof frame.text === "string")
            context.emitText(frame.text);
          else if (frame?.type === "progress")
            context.reportProgress(); // Actual work only, never keep-alive pings.
          else if (
            frame?.type === "result" &&
            frame.turn &&
            typeof frame.turn === "object"
          )
            turn = frame.turn as ProviderTurn;
          else throw new Error("Invalid NDJSON frame");
        }
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              pending += decoder.decode();
              consume(pending);
              break;
            }
            bytes += next.value.byteLength;
            if (bytes > 2_000_000) throw new Error("Oversized response");
            pending += decoder.decode(next.value, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              consume(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
            }
          }
          if (!turn) throw new Error("Missing terminal result");
          return turn; // The kit validates shape, bounds and streaming/capability consistency.
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
    };
  },
);
