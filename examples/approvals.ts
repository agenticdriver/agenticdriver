/** Human review with no provider credentials and no writes outside this process. */
import { createInterface } from "node:readline/promises";
import { AgenticDriver, type JsonObject } from "../src/index.js";
import { mockProvider } from "../src/providers/mock.js";

const proposals: JsonObject[] = [];
const driver = new AgenticDriver({
  providers: [
    mockProvider((request) =>
      request.messages.some((m) => m.role === "tool")
        ? { text: "The reviewed proposal was saved in memory." }
        : {
            text: "Please review this proposal.",
            toolCalls: [
              {
                id: "proposal-one",
                name: "save_proposal",
                arguments: {
                  title: "Aurora",
                  rationale: "A concise working name for the team to evaluate.",
                },
              },
            ],
          },
    ),
  ],
  tools: [
    {
      name: "save_proposal",
      description: "Save a proposed brand name to this demo's memory",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["title", "rationale"],
        additionalProperties: false,
      },
      execute(input) {
        proposals.push(input);
        return { saved: true };
      },
    },
  ],
  approvals: { interactive: true },
});
const ui = createInterface({ input: process.stdin, output: process.stdout });
try {
  for await (const event of driver.stream({
    provider: "mock",
    model: "demo",
    input: "Propose a brand name",
    tools: ["save_proposal"],
    approvals: { mode: "interactive", idlePolicy: "pause" },
  })) {
    if (event.type === "approval.requested") {
      const { approvalId, runId, call } = event.approval;
      console.log(JSON.stringify(call, null, 2));
      const answer = (await ui.question("Approve, deny or cancel? [deny] "))
        .trim()
        .toLowerCase();
      const decision =
        answer === "approve"
          ? "approve"
          : answer === "cancel"
            ? "cancel"
            : "deny";
      driver.decideApproval({ approvalId, runId, call, decision });
    }
    if (event.type === "run.completed") console.log(event.result.text);
    if (event.type === "run.failed" || event.type === "run.cancelled")
      console.log(event.error.code, event.error.message);
  }
  console.log("Saved proposals:", proposals.length);
} finally {
  ui.close();
}
