/** Test-only reference peer. Never loads a real provider or account credentials. */
import { readFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { MemoryContextStore } from "../src/context.js";
import type { ProviderAdapter } from "../src/types.js";
import { MemoryOperationStore } from "../src/operations.js";
import { DriverError } from "../src/errors.js";
import { mockProvider } from "../src/providers/mock.js";
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
const driver = await serve(
  new AgenticDriver({
    operations: new MemoryOperationStore(),
    context: { resolve: contextStore.resolve },
    providers: [
      withMedia(
        mockProvider(async (request, context) => {
          const input = request.messages.at(-1)?.content;
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
        }),
      ),
    ],
    tools: [
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
    tls,
    tokens: [
      { token, subject: "test-user", providers: ["mock"] },
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
    const id = /^\/fixtures\/([^/]+)\/v1\/(runs|providers|protocol)$/.exec(
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
console.log(
  JSON.stringify({
    url: driver.url,
    referenceUrl: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
  }),
);
process.once("SIGTERM", () => {
  for (const response of pending) response.destroy();
  reference.closeAllConnections();
  reference.close();
  void driver.close();
});
