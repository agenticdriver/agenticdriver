// Private owned stdio helper. It has no application callbacks or provider credentials.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const manifest = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  version: number;
  endpoint: string;
  token: string;
  tools: { name: string; description: string; inputSchema: unknown }[];
};
if (manifest.version !== 1) throw new Error("Unsupported bridge manifest.");
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const pending = new AbortController();
let bytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 2_000_000) process.exit(1);
});
createInterface({ input: process.stdin })
  .on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line);
      const reply = (result: unknown) =>
        send({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize")
        reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "agenticdriver-proposals", version: "1" },
        });
      else if (message.method === "tools/list")
        reply({
          tools: manifest.tools.map((tool) => ({
            ...tool,
            // This MCP operation records a proposal, never the eventual application effect.
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          })),
        });
      else if (message.method === "tools/call") {
        const response = await fetch(manifest.endpoint, {
          method: "POST",
          redirect: "error",
          signal: pending.signal,
          headers: {
            authorization: `Bearer ${manifest.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: message.id,
            name: message.params.name,
            arguments: message.params.arguments ?? {},
          }),
        });
        if (!response.ok) throw new Error("Proposal rejected.");
        // Never return an MCP tool result: the parent interrupts and reaps native
        // execution before the SDK validates, approves or executes the proposed batch.
      } else if (message.method === "resources/list") reply({ resources: [] });
      else if (message.method === "resources/templates/list")
        reply({ resourceTemplates: [] });
      else if (message.method === "ping") reply({});
      else if (message.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported bridge operation." },
        });
    })().catch(() => {
      process.exitCode = 1;
      pending.abort();
      process.stdin.destroy();
    });
  })
  .on("close", () => pending.abort());
