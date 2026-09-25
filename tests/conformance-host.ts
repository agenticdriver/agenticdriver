import { managedHost } from "../src/management.js";
/** Test-only reference peer. Never loads a real provider or account credentials. */
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJobStore } from "../src/jobs.js";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import {
  RetrievalService,
  MemoryVectorStore,
  DeterministicEmbeddingAdapter,
} from "../src/retrieval.js";
import { MemoryContextStore } from "../src/context.js";
import type { ProviderAdapter } from "../src/types.js";
import { MemoryOperationStore } from "../src/operations.js";
import { DriverError } from "../src/errors.js";
import { defineProviderExtension } from "../src/provider-kit.js";
import { serve } from "../src/server.js";
import type { ServerResponse } from "node:http";

const fixture = JSON.parse(
  await readFile(
    new URL("../protocol/fixtures/conformance.json", import.meta.url),
    "utf8",
  ),
) as {
  baseEvents: Record<string, unknown>[];
  cases: {
    id: string;
    events?: unknown[];
    raw?: string;
    rawHex?: string;
    json?: unknown;
    operation?: string;
    lineEnding?: string;
    bom?: boolean;
    multiline?: boolean;
    contentType?: string;
    chunkSizes?: number[];
    redirect?: boolean;
    cancel?: boolean;
    repeatText?: { character: string; count: number };
  }[];
};
const token = process.env.AGENTICDRIVER_TOKEN!;
if (!token || token.length < 32)
  throw new Error("A temporary test token is required.");
const tls = process.env.AGENTICDRIVER_TLS_CERT
  ? {
      cert: await readFile(process.env.AGENTICDRIVER_TLS_CERT),
      key: await readFile(process.env.AGENTICDRIVER_TLS_KEY!),
    }
  : undefined;
const metrics = { cancelled: 0, redirects: 0, unauthorized: 0 };
const pending = new Set<ServerResponse>();
const contextStore = new MemoryContextStore();
contextStore.put({
  attachment: {
    type: "text",
    source: {
      id: "source-one",
      revision: "r1",
      location: { documentId: "doc-one", startLine: 1, endLine: 2 },
    },
    mediaType: "text/markdown",
    text: "Selected document",
  },
  subjects: ["test-user"],
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
});
contextStore.put({
  attachment: {
    type: "text",
    source: { id: "ingestion-reference", revision: "r1" },
    mediaType: "text/markdown",
    text: "# Selected reference\nSolar evidence from an app-owned reference.",
  },
  subjects: ["test-user"],
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
});
const withMedia = (adapter: ProviderAdapter): ProviderAdapter => ({
  ...adapter,
  info: {
    ...adapter.info,
    inputMediaTypes: { demo: ["image/png", "application/pdf"] },
    capabilities: {
      ...adapter.info.capabilities,
      images: true,
      documents: true,
    },
  },
});
const jobDirectory = await mkdtemp(
  join(tmpdir(), "agenticdriver-conformance-jobs-"),
);
const jobStore = await SqliteJobStore.open(join(jobDirectory, "jobs.db"), {
  retentionMs: 60_000,
});
const driver = await serve(
  new AgenticDriver({
    sessions: { retentionMs: 60000 },
    usage: {
      hostId: "conformance-host",
      accounts: { mock: "fixture-account" },
    },
    operations: new MemoryOperationStore(),
    approvals: { interactive: true },
    applicationTools: { enabled: true, requireApproval: false },
    context: { resolve: contextStore.resolve },
    ingestion: {
      pdf: {
        extract: async () => ({
          pages: [
            { page: 1, text: "Solar evidence on page one." },
            { page: 2, text: "Battery evidence on page two." },
          ],
          extractor: { id: "pdf-fixture", version: "1" },
        }),
      },
    },
    retrieval: new RetrievalService([
      {
        id: "library",
        version: "v1",
        store: new MemoryVectorStore(),
        embedding: new DeterministicEmbeddingAdapter(64),
        authorize: (_, context) =>
          context.subject === "test-user"
            ? {
                namespace: "test-user",
                sources: {
                  "ingestion-reference": "r1",
                  ...Object.fromEntries(
                    [
                      "typescript",
                      "python",
                      "python-async",
                      "go",
                      "rust",
                      "rust-async",
                    ].flatMap((language) =>
                      ["markdown", "email", "pdf"].map((format) => [
                        `${language}-${format}`,
                        "r1",
                      ]),
                    ),
                  ),
                  "typescript-paper": "r1",
                  "python-paper": "r1",
                  "python-async-paper": "r1",
                  "go-paper": "r1",
                  "rust-paper": "r1",
                  "rust-async-paper": "r1",
                },
              }
            : null,
      },
    ]),
    providers: [
      withMedia(
        defineProviderExtension(
          {
            id: "wire-fixture",
            name: "Independent wire fixture",
            version: "1.0.0",
            contractVersion: "1.0",
            vendor: "mock",
            authMode: "none",
            usageSource: "synthetic",
            capabilities: {
              tools: true,
              textStreaming: false,
              historyContinuation: true,
              nativeContinuation: true,
            },
          },
          () => ({
            async complete(request, context) {
              const input = request.messages.at(-1)?.content;
              if (input === "session-first")
                return {
                  text: "first visible reply",
                  native: { marker: "private-state" },
                };
              if (input === "session-next") {
                if (
                  !request.messages.some(
                    (message) =>
                      message.role === "user" &&
                      message.content === "session-first",
                  )
                )
                  throw new Error("Missing conversation history");
                return { text: "continued" };
              }
              if (input === "conformance-application-tool")
                return {
                  text: "Use the app function",
                  toolCalls: [
                    {
                      id: "application-call",
                      name: "application_lookup",
                      arguments: { query: "solar" },
                    },
                  ],
                };
              if (input === "conformance-approval")
                return {
                  text: "Review this action",
                  toolCalls: [
                    {
                      id: "approval-call",
                      name: "approved_echo",
                      arguments: { text: "Review 🌍", nested: { ids: [1, 2] } },
                    },
                  ],
                };
              if (input === "conformance-cost")
                return {
                  text: "AgenticDriver is connected.",
                  usage: { apiEquivalentCostUsd: 0.25 },
                };
              if (input === "conformance-uncertain")
                throw new DriverError(
                  "IDLE_TIMEOUT",
                  "The fixture tool outcome is uncertain.",
                  false,
                  "uncertain",
                );
              if (input === "conformance-stall") return new Promise(() => {});
              if (input === "conformance-progress") {
                for (let n = 0; n < 16; n++) {
                  await delay(20, undefined, { signal: context.signal });
                  context.reportProgress();
                }
              }
              if (input === "conformance-quiet")
                await delay(80, undefined, { signal: context.signal });
              return { text: "AgenticDriver is connected." };
            },
          }),
        ).create({ id: "mock", models: ["demo"] }),
      ),
    ],
    tools: [
      {
        name: "approved_echo",
        description: "An approval-gated fixture",
        requiresApproval: true,
        inputSchema: { type: "object" },
        execute: (input) => input,
      },
      {
        name: "echo",
        description: "Test tool",
        inputSchema: { type: "object" },
        execute: (input) => input,
      },
    ],
  }),
  {
    port: 0,
    jobs: { store: jobStore, pollIntervalMs: 10 },
    tls,
    tokens: [
      {
        token,
        subject: "test-user",
        providers: ["mock"],
        tools: ["approved_echo"],
        approveTools: ["approved_echo", "application_lookup"],
        sessions: ["create", "read", "continue", "delete"],
        jobs: ["submit", "read", "cancel"],
        applicationTools: [
          { name: "application_lookup", requiresApproval: false },
        ],
        retrieval: {
          search: ["library"],
          index: ["library"],
          delete: ["library"],
        },
      },
      {
        token: token + "-restricted",
        subject: "restricted-user",
        providers: [],
      },
    ],
  },
);
const handler: Parameters<typeof httpServer>[1] = async (req, res) => {
  try {
    if (req.url === "/redirect-target") {
      metrics.redirects++;
      res.writeHead(500);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      metrics.unauthorized++;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid test token",
            retryable: false,
          },
        }),
      );
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
      return;
    }
    const id =
      /^\/fixtures\/([^/]+)\/v1\/(runs|providers|protocol|retrieval\/ingest|approvals\/decisions|tool-executions\/(?:progress|results)|sessions\/(?:create|read|delete)|jobs\/(?:submit|read|cancel|events))$/.exec(
        req.url ?? "",
      )?.[1];
    const example = fixture.cases.find((c) => c.id === id);
    if (!example) {
      res.writeHead(404);
      res.end();
      return;
    }
    for await (const _chunk of req) {
      /* Drain the small test request. */
    }
    if (example.redirect) {
      res.writeHead(302, { Location: "/redirect-target" });
      res.end();
      return;
    }
    let body: Buffer;
    if (example.rawHex !== undefined) body = Buffer.from(example.rawHex, "hex");
    else if (example.raw !== undefined) body = Buffer.from(example.raw);
    else if (example.json !== undefined)
      body = Buffer.from(JSON.stringify(example.json));
    else {
      const events = structuredClone(example.events ?? fixture.baseEvents);
      if (example.repeatText)
        (events[1] as { text: string }).text =
          example.repeatText.character.repeat(example.repeatText.count);
      const ending = example.lineEnding ?? "\n";
      const encoded = events
        .map((event) => {
          const lines = JSON.stringify(
            event,
            null,
            example.multiline ? 2 : undefined,
          ).split("\n");
          return (
            ": reference peer comment" +
            ending +
            lines.map((line) => "data: " + line).join(ending) +
            ending +
            ending
          );
        })
        .join("");
      body = Buffer.from((example.bom ? "\uFEFF" : "") + encoded);
    }
    res.writeHead(200, {
      "Content-Type":
        example.contentType ??
        (example.operation ? "application/json" : "text/event-stream"),
      "AgenticDriver-Version": "1.0",
    });
    if (example.cancel) {
      pending.add(res);
      res.once("close", () => {
        pending.delete(res);
        metrics.cancelled++;
      });
    }
    res.flushHeaders();
    let offset = 0,
      index = 0;
    const sizes = example.chunkSizes ?? [16_384];
    while (offset < body.length && !res.destroyed) {
      const chunk = body.subarray(
        offset,
        offset + sizes[index++ % sizes.length]!,
      );
      offset += chunk.length;
      if (!res.write(chunk))
        await new Promise<void>((resolve) => {
          const settled = () => {
            res.off("drain", settled);
            res.off("close", settled);
            resolve();
          };
          res.once("drain", settled);
          res.once("close", settled);
        });
      if (example.chunkSizes) await immediate();
    }
    if (!example.cancel) res.end();
  } catch {
    res.destroy();
  }
};
const reference = tls ? httpsServer(tls, handler) : httpServer(handler);
reference.listen(0, "127.0.0.1");
await once(reference, "listening");
const address = reference.address();
if (!address || typeof address === "string")
  throw new Error("No reference listener.");
const managementDirectory = await mkdtemp(
  join(tmpdir(), "driver-management-wire-"),
);
const managementPath = join(managementDirectory, "config.json");
await writeFile(
  managementPath,
  JSON.stringify({ version: 1, providers: [{ kind: "mock", id: "fixture" }] }),
  { mode: 0o600 },
);
const managementHost = await managedHost(managementPath);
const managementServer = await serve(managementHost.driver, {
  port: 0,
  tls,
  tokens: [
    { token, subject: "test-operator", providers: [], manageProviders: true },
  ],
  management: managementHost.management,
});
console.log(
  JSON.stringify({
    url: driver.url,
    managementUrl: managementServer.url,
    referenceUrl: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
  }),
);
process.once("SIGTERM", () => {
  for (const response of pending) response.destroy();
  reference.closeAllConnections();
  reference.close();
  void Promise.all([driver.close(), managementServer.close()])
    .then(() => rm(managementDirectory, { recursive: true, force: true }))
    .then(() => jobStore.close())
    .then(() => rm(jobDirectory, { recursive: true, force: true }));
});
