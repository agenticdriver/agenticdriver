/** A function stays in this application while a loopback host runs the model loop. */
import { AgenticDriver, type ApplicationToolDefinition } from "../src/index.js";
import { AgenticClient } from "../src/client.js";
import { configuredProvider } from "./config.js";
const { provider, model } = configuredProvider();
if (!provider.info.capabilities.tools)
  throw new Error(
    "The selected real provider does not support application tools in this mode.",
  );
import { serve } from "../src/server.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
const document = process.env.AGENTICDRIVER_INPUT_FILE;
if (!document)
  throw new Error(
    "Set AGENTICDRIVER_INPUT_FILE to a permitted Markdown document.",
  );
const passages = (await readFile(document, "utf8"))
  .split(/\n\s*\n/)
  .filter(Boolean);

const definition: ApplicationToolDefinition = {
  name: "search_passages",
  description: "Search this application's example evidence",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { passages: { type: "array", items: { type: "string" } } },
    required: ["passages"],
    additionalProperties: false,
  },
};
const driver = new AgenticDriver({
  providers: [provider],
  // Search only the explicitly selected document; no writes or implicit retrieval.
  applicationTools: { enabled: true, requireApproval: false },
});
const token = randomBytes(32).toString("base64url");
const host = await serve(driver, {
  port: 0,
  tokens: [
    {
      token,
      subject: "application-example",
      providers: [provider.info.id],
      applicationTools: [{ name: definition.name, requiresApproval: false }],
    },
  ],
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

try {
  const client = new AgenticClient({ url: host.url, token });
  for await (const event of client.stream(
    {
      provider: provider.info.id,
      model,
      input:
        "Search the selected document for evidence about retrieval, then explain which claims are directly supported. Quote the matching passages and identify missing evidence. Do not invent a result if no passages match.",
      tools: [definition.name],
      applicationTools: [definition],
    },
    { signal: controller.signal },
  )) {
    if (event.type === "tool.execution.requested") {
      const { executionId, runId, call } = event.execution;
      const identity = { executionId, runId, callId: call.id };
      controller.signal.throwIfAborted();
      const output = {
        passages: passages.filter((text) =>
          text
            .toLowerCase()
            .includes(String(call.arguments.query).toLowerCase()),
        ),
      };
      await client.reportToolProgress(identity, { signal: controller.signal });
      await client.completeTool(
        { ...identity, output },
        { signal: controller.signal },
      );
      console.log(output);
    }
    if (event.type === "run.completed") console.log(event.result.text);
    if (event.type === "run.failed" || event.type === "run.cancelled")
      throw new Error(event.error.code);
  }
} finally {
  await host.close();
}
