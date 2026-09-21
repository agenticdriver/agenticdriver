import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as httpsServer } from "node:https";
import { AgenticDriver } from "./driver.js";
import {
  SessionOperationSchema,
  type SessionOperation,
  type SessionCreate,
  type SessionIdentity,
} from "./session-types.js";
import type { ApprovalDecision } from "./approval-types.js";
import {
  ApplicationToolGrantSchema,
  type ApplicationToolGrant,
  type ToolExecutionIdentity,
  type ToolExecutionResult,
} from "./tool-types.js";
import { DriverError, publicError } from "./errors.js";
import { isLoopback } from "./security.js";
import {
  negotiateProtocolVersion,
  OPTIONAL_EVENTS_HEADER,
  protocolInfo,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
} from "./protocol.js";
import type { RunRequest } from "./types.js";
import {
  RetrievalIdSchema,
  RetrievalSearchSchema,
  RetrievalIndexRequestSchema,
  RetrievalDeleteSchema,
} from "./retrieval-types.js";
import { IngestRequestSchema } from "./ingestion-types.js";
import type { RetrievalOperation } from "./retrieval.js";
import { FairScheduler, type SchedulingOptions } from "./scheduling.js";

export interface AccessToken {
  sessions?: SessionOperation[];
  /** Use at least 32 random characters. Authentication compares SHA-256 token digests. */
  token: string;
  subject: string;
  providers: string[];
  tools?: string[];
  /** Separate permission to decide approvals; invoking tools does not grant it. */
  approveTools?: string[];
  applicationTools?: ApplicationToolGrant[];
  /** Explicit corpus allowlists for each operation. Omitted permissions deny retrieval access. */
  retrieval?: Partial<Record<RetrievalOperation, string[]>>;
}
export interface ServerOptions {
  tokens: AccessToken[];
  host?: string;
  port?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
  allowedOrigins?: string[];
  maxConcurrentRuns?: number;
  maxConcurrentRunsPerSubject?: number;
  /** Configure here or on the driver, never both. */
  scheduling?: SchedulingOptions;
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
    if (entry.token.length < 32 || !entry.subject || entry.subject.length > 128)
      throw new Error(
        "Tokens require at least 32 characters and a subject of 1 to 128 characters.",
      );
    const digest = createHash("sha256").update(entry.token).digest();
    if (hashes.has(digest.toString("hex")))
      throw new Error("Duplicate access token.");
    hashes.add(digest.toString("hex"));
    const applicationTools = ApplicationToolGrantSchema.array()
      .max(32)
      .parse(entry.applicationTools ?? []);
    if (
      new Set(applicationTools.map((tool) => tool.name)).size !==
      applicationTools.length
    )
      throw new Error("Application tool token grants must have unique names.");
    return {
      sessions: SessionOperationSchema.array()
        .max(4)
        .parse(entry.sessions ?? []),
      applicationTools,
      digest,
      subject: entry.subject,
      providers: [...entry.providers],
      tools: [...(entry.tools ?? [])],
      approveTools: [...(entry.approveTools ?? [])],
      retrieval: Object.fromEntries(
        ["search", "index", "delete"].map((operation) => [
          operation,
          (entry.retrieval?.[operation as RetrievalOperation] ?? []).map((id) =>
            RetrievalIdSchema.parse(id),
          ),
        ]),
      ) as Record<RetrievalOperation, string[]>,
    };
  });
  const active = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  let closing = false;
  let closed: Promise<void> | undefined;
  const hasLegacyLimits =
    options.maxConcurrentRuns !== undefined ||
    options.maxConcurrentRunsPerSubject !== undefined;
  if (
    (driver.scheduler && (options.scheduling || hasLegacyLimits)) ||
    (options.scheduling && hasLegacyLimits)
  )
    throw new DriverError(
      "INVALID_SCHEDULING",
      "Configure scheduling once: on the driver, on the server, or through legacy server concurrency limits.",
    );
  const scheduler =
    driver.scheduler ??
    new FairScheduler(
      options.scheduling ?? {
        total: options.maxConcurrentRuns,
        perSubject: options.maxConcurrentRunsPerSubject,
      },
    );
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(PROTOCOL_VERSION_HEADER, PROTOCOL_VERSION);
    if (options.tls)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    let release: (() => void) | undefined;
    try {
      if (closing)
        throw new DriverError(
          "HOST_SHUTTING_DOWN",
          "The execution host is shutting down.",
          true,
        );
      const origin = req.headers.origin;
      if (origin) {
        if (!options.allowedOrigins?.includes(origin))
          throw new DriverError(
            "ORIGIN_DENIED",
            "This browser origin is not allowed.",
          );
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Expose-Headers", PROTOCOL_VERSION_HEADER);
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader(
            "Access-Control-Allow-Headers",
            `Authorization, Content-Type, Accept, ${PROTOCOL_VERSION_HEADER}, ${OPTIONAL_EVENTS_HEADER}`,
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
      negotiateProtocolVersion(
        req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()],
      );
      if (req.url === "/v1/protocol" && req.method === "GET") {
        json(
          res,
          200,
          protocolInfo({
            sessions: driver.supportsSessions,
            applicationTools: driver.supportsApplicationTools,
            interactiveApprovals: driver.supportsInteractiveApprovals,
            idempotency: driver.supportsIdempotency,
            contextReferences: driver.supportsContextReferences,
            retrieval: driver.supportsRetrieval,
            pdfIngestion: driver.supportsPdfIngestion,
          }),
        );
        return;
      }
      if (
        (req.url === "/v1/providers" ||
          req.url === "/v1/providers?refresh=true") &&
        req.method === "GET"
      ) {
        json(res, 200, {
          providers: await driver.discoverProviders({
            providers: principal.providers,
            refresh: req.url.endsWith("?refresh=true"),
          }),
        });
        return;
      }
      const approvalDecision = req.url === "/v1/approvals/decisions";
      const sessionOperation =
        req.url === "/v1/sessions/create"
          ? "create"
          : req.url === "/v1/sessions/read"
            ? "read"
            : req.url === "/v1/sessions/delete"
              ? "delete"
              : undefined;
      const toolOperation =
        req.url === "/v1/tool-executions/progress"
          ? "progress"
          : req.url === "/v1/tool-executions/results"
            ? "results"
            : undefined;
      const retrievalOperation = (
        {
          "/v1/retrieval/search": "search",
          "/v1/retrieval/index": "index",
          "/v1/retrieval/delete": "delete",
          "/v1/retrieval/ingest": "ingest",
        } as Record<string, RetrievalOperation | "ingest">
      )[req.url ?? ""];
      if (
        (req.url !== "/v1/runs" &&
          !retrievalOperation &&
          !approvalDecision &&
          !sessionOperation &&
          !toolOperation) ||
        req.method !== "POST"
      ) {
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
      const body = await readRequest(req);
      if (sessionOperation) {
        const identity = {
          subject: principal.subject,
          providers: principal.providers,
          sessions: principal.sessions,
        };
        const result =
          sessionOperation === "create"
            ? driver.createSession(body as SessionCreate, identity)
            : sessionOperation === "read"
              ? driver.readSession(body as SessionIdentity, identity)
              : driver.deleteSession(body as SessionIdentity, identity);
        json(res, 200, result);
        return;
      }
      if (toolOperation) {
        const executor = {
          subject: principal.subject,
          providers: principal.providers,
          applicationTools: principal.applicationTools.map(
            (grant) => grant.name,
          ),
        };
        const receipt =
          toolOperation === "progress"
            ? driver.reportToolProgress(body as ToolExecutionIdentity, executor)
            : driver.completeTool(body as ToolExecutionResult, executor);
        json(res, 200, receipt);
        return;
      }
      if (approvalDecision) {
        // A waiting run occupies a slot. Its decision must not compete for that slot.
        // Validate the original body inside the driver, including exact argument preservation.
        const result = driver.decideApproval(body as ApprovalDecision, {
          subject: principal.subject,
          providers: principal.providers,
          approveTools: principal.approveTools,
        });
        json(res, 200, result);
        return;
      }
      const retrievalSchema =
        retrievalOperation === "ingest"
          ? IngestRequestSchema
          : retrievalOperation === "search"
            ? RetrievalSearchSchema
            : retrievalOperation === "index"
              ? RetrievalIndexRequestSchema
              : RetrievalDeleteSchema;
      const parsedRetrieval = retrievalOperation
        ? retrievalSchema.safeParse(body)
        : undefined;
      if (parsedRetrieval && !parsedRetrieval.success)
        throw new DriverError(
          "INVALID_RETRIEVAL",
          "The retrieval request does not match the schema.",
        );
      const retrievalRequest = parsedRetrieval?.data;
      const request = retrievalOperation
        ? undefined
        : driver.validate(body as RunRequest);
      if (closing)
        throw new DriverError(
          "HOST_SHUTTING_DOWN",
          "The execution host is shutting down.",
          true,
        );
      if (
        (request &&
          (!principal.providers.includes(request.provider) ||
            request.tools?.some((name) =>
              request.applicationTools?.some(
                (definition) => definition.name === name,
              )
                ? !principal.applicationTools.some(
                    (grant) => grant.name === name,
                  )
                : !principal.tools.includes(name),
            ) ||
            (request.retrieval &&
              !principal.retrieval.search.includes(
                request.retrieval.corpus,
              )))) ||
        (retrievalOperation &&
          !principal.retrieval[
            retrievalOperation === "ingest" ? "index" : retrievalOperation
          ].includes(retrievalRequest!.corpus))
      )
        throw new DriverError(
          "FORBIDDEN",
          "This token cannot access the requested provider, tools or retrieval operation.",
        );
      const controller = new AbortController();
      active.add(controller);
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      release = () => {
        active.delete(controller);
        res.off("close", disconnect);
      };
      const ticket = scheduler.submit(
        request
          ? driver.usageIdentity(request.provider, principal.subject)
          : { subject: principal.subject },
        controller.signal,
      );
      const cleanup = release;
      release = () => {
        ticket.release();
        cleanup();
      };
      const runOptions = {
        admission: () => ticket.wait(),
        sessionOperations: principal.sessions,
        subject: principal.subject,
        signal: controller.signal,
        applicationToolApprovals: principal.applicationTools
          .filter((grant) => grant.requiresApproval !== false)
          .map((grant) => grant.name),
      };
      if (retrievalOperation) {
        await ticket.wait();
        const result =
          retrievalOperation === "ingest"
            ? await driver.ingestContext(
                IngestRequestSchema.parse(retrievalRequest),
                runOptions,
              )
            : retrievalOperation === "search"
              ? await driver.searchContext(
                  RetrievalSearchSchema.parse(retrievalRequest),
                  runOptions,
                )
              : retrievalOperation === "index"
                ? await driver.indexContext(
                    RetrievalIndexRequestSchema.parse(retrievalRequest),
                    runOptions,
                  )
                : await driver.deleteContext(
                    RetrievalDeleteSchema.parse(retrievalRequest),
                    runOptions,
                  );
        json(res, 200, result);
        return;
      }
      if (req.headers.accept?.includes("text/event-stream")) {
        const events = driver.stream(request!, runOptions);
        // Claims and conflicts must be resolved before a successful stream response is committed.
        let next = await events.next();
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
          while (!next.done) {
            const event = next.value;
            if (res.destroyed) break;
            if (
              !res.write(
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
            )
              await once(res, "drain", { signal: controller.signal });
            next = await events.next();
          }
        } finally {
          clearInterval(heartbeat);
          await events.return(undefined);
        }
        res.end();
      } else json(res, 200, await driver.run(request!, runOptions));
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
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const pending = handler(req, res);
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
  };
  const server = options.tls
    ? httpsServer({ ...options.tls, minVersion: "TLSv1.2" }, handle)
    : httpServer(handle);
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
    close(): Promise<void> {
      return (closed ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const controller of active) controller.abort();
        server.closeAllConnections();
        await stopped;
        // Let cancellation persist terminal records and release per-run resources.
        await Promise.allSettled([...requests]);
      })());
    },
  };
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function statusFor(code: string) {
  if (code === "SESSION_NOT_FOUND") return 404;
  if (
    [
      "SESSION_REVISION_CONFLICT",
      "SESSION_BUSY",
      "SESSION_INTERRUPTED",
      "SESSION_PROVIDER_MISMATCH",
      "SESSION_ACCOUNT_CHANGED",
    ].includes(code)
  )
    return 409;
  if (code === "SESSION_CAPACITY") return 429;
  if (
    [
      "SESSIONS_UNAVAILABLE",
      "INVALID_SESSION",
      "UNSUPPORTED_CONTINUATION",
      "SESSION_ACCOUNT_REQUIRED",
      "SESSION_HISTORY_CONFLICT",
      "SESSION_CONTEXT_UNSUPPORTED",
      "SESSION_CONTEXT_LIMIT",
      "INVALID_SESSION_STATE",
    ].includes(code)
  )
    return 400;
  if (code === "UNAUTHORIZED") return 401;
  if (["APPROVAL_NOT_FOUND", "TOOL_EXECUTION_NOT_FOUND"].includes(code))
    return 404;
  if (
    [
      "APPROVAL_MISMATCH",
      "TOOL_EXECUTION_MISMATCH",
      "TOOL_DEFINITION_CONFLICT",
    ].includes(code)
  )
    return 409;
  if (
    [
      "FORBIDDEN",
      "ORIGIN_DENIED",
      "APPROVAL_REQUIRED",
      "APPROVAL_DENIED",
    ].includes(code)
  )
    return 403;
  if (code === "BODY_TOO_LARGE") return 413;
  if (
    [
      "IDEMPOTENCY_CONFLICT",
      "OPERATION_IN_PROGRESS",
      "OPERATION_UNCERTAIN",
      "TOOL_OUTCOME_UNCERTAIN",
      "SOURCE_CONFLICT",
      "CHUNK_CONFLICT",
      "INDEX_INCOMPATIBLE",
    ].includes(code)
  )
    return 409;
  if (
    [
      "APPROVAL_AUDIT_FAILED",
      "OPERATION_STORE_ERROR",
      "OPERATION_STORE_FULL",
      "OPERATION_RECORD_LIMIT",
      "HOST_SHUTTING_DOWN",
      "RESOURCE_POLICY_UNAVAILABLE",
    ].includes(code)
  )
    return 503;
  if (
    [
      "BUSY",
      "QUEUE_FULL",
      "RATE_LIMITED",
      "APPROVAL_CAPACITY",
      "TOOL_EXECUTOR_CAPACITY",
    ].includes(code)
  )
    return 429;
  if (code === "IDLE_TIMEOUT" || code === "TIMEOUT") return 504;
  if (
    [
      "RESOURCE_LIMIT",
      "RESOURCE_USAGE_UNKNOWN",
      "RESOURCE_ADMISSION_DENIED",
    ].includes(code)
  )
    return 403;
  if (code === "ADMISSION_IDENTITY_REQUIRED") return 503;
  if (
    [
      "INVALID_TOOL_EXECUTION",
      "INVALID_TOOL_OUTPUT",
      "TOOL_OUTPUT_LIMIT",
      "TOOL_DEFINITION_LIMIT",
      "APPLICATION_TOOLS_UNAVAILABLE",
      "TOOL_STREAM_REQUIRED",
      "INVALID_APPROVAL",
      "APPROVAL_UNAVAILABLE",
      "APPROVAL_POLICY",
      "APPROVAL_STREAM_REQUIRED",
      "INVALID_REQUEST",
      "IDEMPOTENCY_UNAVAILABLE",
      "INVALID_SCHEMA",
      "UNKNOWN_PROVIDER",
      "UNKNOWN_TOOL",
      "UNSUPPORTED_MODEL",
      "UNSUPPORTED_TOOLS",
      "UNSUPPORTED_CAPABILITY",
      "UNSUPPORTED_PROTOCOL_VERSION",
      "INVALID_RETRIEVAL",
      "INVALID_INGESTION",
      "INVALID_DOCUMENT",
      "DOCUMENT_LIMIT",
      "EMPTY_DOCUMENT",
      "EMPTY_EXTRACTION",
      "OCR_REQUIRED",
      "PDF_EXTRACTOR_REQUIRED",
      "PDF_ENCRYPTED",
      "PDF_PERMISSIONS",
      "RETRIEVAL_UNAVAILABLE",
      "NO_RETRIEVAL_EVIDENCE",
    ].includes(code)
  )
    return 400;
  if (code === "INTERNAL_ERROR") return 500;
  return 502;
}
async function readRequest(req: IncomingMessage): Promise<unknown> {
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
