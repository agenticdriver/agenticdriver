import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DriverError } from "../errors.js";
import type { ToolCall, ToolDefinition } from "../types.js";

const proposal = z
  .object({
    requestId: z.union([z.string().min(1).max(256), z.number().int()]),
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const invalid = () =>
  new DriverError(
    "CLI_POLICY_VIOLATION",
    "The native application-tool proposal could not be verified.",
  );

/** The helper proposes actions only. Application callbacks never enter native MCP. */
export async function codexMcpBridge(options: {
  directory: string;
  tools: ToolDefinition[];
  interrupt(): void;
  fail(error: DriverError): void;
}) {
  const name = `agenticdriver_${randomBytes(12).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const calls: { nativeId: string; call: ToolCall; confirmed: boolean }[] = [];
  const received: z.infer<typeof proposal>[] = [];
  const requestIds = new Set<string>();
  const prefix = randomUUID();
  let interrupting = false,
    stopped = false;
  const reconcile = () => {
    for (const entry of calls) {
      if (entry.confirmed) continue;
      const index = received.findIndex(
        (p) =>
          p.name === entry.call.name &&
          isDeepStrictEqual(p.arguments, entry.call.arguments),
      );
      if (index !== -1) {
        received.splice(index, 1);
        entry.confirmed = true;
      }
    }
    if (
      !interrupting &&
      calls.length &&
      calls.every((c) => c.confirmed) &&
      !received.length
    ) {
      interrupting = true;
      options.interrupt();
    }
  };
  const server = createServer(
    { maxHeaderSize: 4096 },
    async (request, response) => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (
        supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization)
      ) {
        response.writeHead(401).end();
        request.resume();
        return;
      }
      try {
        if (
          stopped ||
          request.method !== "POST" ||
          request.url !== "/proposal" ||
          request.headers["content-type"] !== "application/json"
        )
          throw invalid();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1_000_000) throw invalid();
          chunks.push(chunk);
        }
        const value = proposal.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        const id = JSON.stringify(value.requestId);
        if (requestIds.has(id) || requestIds.size >= 32) throw invalid();
        requestIds.add(id);
        received.push(value);
        response.writeHead(204).end();
        reconcile();
      } catch {
        response.writeHead(400).end();
        options.fail(invalid());
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = async () => {
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw invalid();
    const manifest = JSON.stringify({
      version: 1,
      endpoint: `http://127.0.0.1:${address.port}/proposal`,
      token,
      tools: options.tools,
    });
    if (Buffer.byteLength(manifest) > 1_000_000)
      throw new DriverError(
        "TOOL_LIMIT",
        "The native tool definitions exceed the bridge size limit.",
      );
    const path = join(options.directory, "application-tools.json");
    await writeFile(path, manifest, { mode: 0o600, flag: "wx" });
    return {
      name,
      config: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./codex-mcp-helper.js", import.meta.url)),
          path,
        ],
        required: true,
        enabled: true,
        enabled_tools: options.tools.map((tool) => tool.name),
        // Only proposal transport occurs here; no application approval/tool waits.
        tool_timeout_sec: 60,
        env_vars: [],
      },
      started(item: Record<string, unknown>) {
        if (
          stopped ||
          item.server !== name ||
          typeof item.id !== "string" ||
          !item.id ||
          calls.some((c) => c.nativeId === item.id) ||
          calls.length >= 32
        )
          throw invalid();
        const p = proposal.parse({
          requestId: item.id,
          name: item.tool,
          arguments: item.arguments,
        });
        calls.push({
          nativeId: item.id,
          call: {
            id: `${prefix}:${calls.length}`,
            name: p.name,
            arguments: p.arguments,
          },
          confirmed: false,
        });
        reconcile();
      },
      completed(item: Record<string, unknown>) {
        // An MCP timeout/error must not become a model continuation or an app effect.
        if (
          !interrupting ||
          item.server !== name ||
          !calls.some((c) => c.nativeId === item.id)
        )
          throw invalid();
      },
      get interrupted() {
        return interrupting;
      },
      finish() {
        if (
          !interrupting ||
          !calls.length ||
          received.length ||
          calls.some((c) => !c.confirmed)
        )
          throw invalid();
        return calls.map((c) => c.call);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
