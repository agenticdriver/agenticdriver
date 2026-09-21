/** A function stays in this application while a loopback host runs the model loop. */
import { AgenticDriver, type ApplicationToolDefinition } from "../src/index.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { randomBytes } from "node:crypto";

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
  providers: [
    mockProvider((input) =>
      input.messages.some((message) => message.role === "tool")
        ? { text: "The application returned its matching evidence." }
        : {
            text: "",
            toolCalls: [
              {
                id: "lookup-one",
                name: definition.name,
                arguments: { query: "solar" },
              },
            ],
          },
    ),
  ],
  // This demo exposes only a read-only, in-memory lookup.
  applicationTools: { enabled: true, requireApproval: false },
});
const token = randomBytes(32).toString("base64url");
const host = await serve(driver, {
  port: 0,
  tokens: [
    {
      token,
      subject: "demo",
      providers: ["mock"],
      applicationTools: [{ name: definition.name, requiresApproval: false }],
    },
  ],
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const passages = [
  "Solar cells convert light into electricity.",
  "Wind turbines convert moving air into electricity.",
];
try {
  const client = new AgenticClient({ url: host.url, token });
  for await (const event of client.stream(
    {
      provider: "mock",
      model: "demo",
      input: "Find evidence about solar power",
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
