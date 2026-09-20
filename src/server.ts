import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as httpsServer } from "node:https";
import { AgenticDriver } from "./driver.js";
import { DriverError, publicError } from "./errors.js";
import { isLoopback } from "./security.js";
import type { RunRequest } from "./types.js";

export interface AccessToken {
  /** Use at least 32 random characters. Authentication compares SHA-256 token digests. */
  token: string;
  subject: string;
  providers: string[];
  tools?: string[];
}
export interface ServerOptions {
  tokens: AccessToken[];
  host?: string;
  port?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
  allowedOrigins?: string[];
  maxConcurrentRuns?: number;
  maxConcurrentRunsPerSubject?: number;
}

/** An authenticated, scoped execution host. Bind loopback, or provide TLS for remote listening. */
export async function serve(driver: AgenticDriver, options: ServerOptions) {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host) && !options.tls)
    throw new DriverError(
      "TLS_REQUIRED",
      "A non-loopback listener requires TLS key and certificate.",
    );
  if (!options.tokens.length)
    throw new Error("Configure at least one access token.");
  const hashes = new Set<string>();
  const tokens = options.tokens.map((entry) => {
    if (entry.token.length < 32 || !entry.subject)
      throw new Error("Tokens require at least 32 characters and a subject.");
    const digest = createHash("sha256").update(entry.token).digest();
    if (hashes.has(digest.toString("hex")))
      throw new Error("Duplicate access token.");
    hashes.add(digest.toString("hex"));
    return {
      digest,
      subject: entry.subject,
      providers: [...entry.providers],
      tools: [...(entry.tools ?? [])],
    };
  });
  const active = new Set<AbortController>(),
    subjectRuns = new Map<string, number>();
  const maxConcurrent = options.maxConcurrentRuns ?? 32,
    maxPerSubject = options.maxConcurrentRunsPerSubject ?? 4;
  if (
    ![maxConcurrent, maxPerSubject].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new Error("Concurrency limits must be positive integers.");
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (options.tls)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    let release: (() => void) | undefined;
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!options.allowedOrigins?.includes(origin))
          throw new DriverError(
            "ORIGIN_DENIED",
            "This browser origin is not allowed.",
          );
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Accept",
          );
          res.writeHead(204);
          res.end();
          return;
        }
      }
      if (req.url === "/health" && req.method === "GET") {
        json(res, 200, { status: "ok", protocol: "agenticdriver.v1" });
        return;
      }
      const auth = req.headers.authorization;
      const digest = createHash("sha256")
        .update(auth?.startsWith("Bearer ") ? auth.slice(7) : "")
        .digest();
      const principal = tokens.find((entry) =>
        timingSafeEqual(entry.digest, digest),
      );
      if (!principal)
        throw new DriverError(
          "UNAUTHORIZED",
          "A valid driver bearer token is required.",
        );
      if (req.url === "/v1/providers" && req.method === "GET") {
        json(res, 200, {
          providers: driver
            .listProviders()
            .filter((p) => principal.providers.includes(p.id)),
        });
        return;
      }
      if (req.url !== "/v1/runs" || req.method !== "POST") {
        json(res, 404, {
          error: new DriverError("NOT_FOUND", "Endpoint not found.").toJSON(),
        });
        return;
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
      )
        throw new DriverError(
          "INVALID_REQUEST",
          "Use application/json for run requests.",
        );
      if (
        req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity"
      )
        throw new DriverError(
          "INVALID_REQUEST",
          "Compressed requests are not supported.",
        );
      const request = driver.validate(await readRequest(req));
      if (
        !principal.providers.includes(request.provider) ||
        request.tools?.some((name) => !principal.tools.includes(name))
      )
        throw new DriverError(
          "FORBIDDEN",
          "This token cannot access the requested provider or tools.",
        );
      if (
        active.size >= maxConcurrent ||
        (subjectRuns.get(principal.subject) ?? 0) >= maxPerSubject
      )
        throw new DriverError(
          "BUSY",
          "The execution host has reached its concurrency limit.",
          true,
        );
      const controller = new AbortController();
      active.add(controller);
      subjectRuns.set(
        principal.subject,
        (subjectRuns.get(principal.subject) ?? 0) + 1,
      );
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      release = () => {
        active.delete(controller);
        const n = (subjectRuns.get(principal.subject) ?? 1) - 1;
        if (n) subjectRuns.set(principal.subject, n);
        else subjectRuns.delete(principal.subject);
        res.off("close", disconnect);
      };
      const runOptions = {
        subject: principal.subject,
        signal: controller.signal,
      };
      if (req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableNeedDrain)
            res.write(": heartbeat\n\n");
        }, 15_000);
        try {
          for await (const event of driver.stream(request, runOptions)) {
            if (res.destroyed) break;
            if (
              !res.write(
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
            )
              await once(res, "drain", { signal: controller.signal });
          }
        } finally {
          clearInterval(heartbeat);
        }
        res.end();
      } else json(res, 200, await driver.run(request, runOptions));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const failure = publicError(error);
      json(res, statusFor(failure.code), { error: failure.toJSON() });
    } finally {
      release?.();
    }
  };
  const server = options.tls
    ? httpsServer(
        { ...options.tls, minVersion: "TLSv1.2" },
        (req, res) => void handler(req, res),
      )
    : httpServer((req, res) => void handler(req, res));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7433, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not determine server address.");
  return {
    url: `${options.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function statusFor(code: string) {
  if (code === "UNAUTHORIZED") return 401;
  if (["FORBIDDEN", "ORIGIN_DENIED", "APPROVAL_REQUIRED"].includes(code))
    return 403;
  if (code === "BODY_TOO_LARGE") return 413;
  if (code === "BUSY" || code === "RATE_LIMITED") return 429;
  if (code === "IDLE_TIMEOUT" || code === "TIMEOUT") return 504;
  if (
    [
      "INVALID_REQUEST",
      "INVALID_SCHEMA",
      "UNKNOWN_PROVIDER",
      "UNKNOWN_TOOL",
      "UNSUPPORTED_MODEL",
      "UNSUPPORTED_TOOLS",
    ].includes(code)
  )
    return 400;
  if (code === "INTERNAL_ERROR") return 500;
  return 502;
}
async function readRequest(req: IncomingMessage): Promise<RunRequest> {
  if (Number(req.headers["content-length"] ?? 0) > 1_000_000)
    throw new DriverError("BODY_TOO_LARGE", "Requests must not exceed 1 MB.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1_000_000)
      throw new DriverError("BODY_TOO_LARGE", "Requests must not exceed 1 MB.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunRequest;
  } catch {
    throw new DriverError(
      "INVALID_REQUEST",
      "The request must contain valid JSON.",
    );
  }
}
