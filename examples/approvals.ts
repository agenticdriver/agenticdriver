/** A real provider proposes a brand direction; a human approves saving it in memory. */
import { createInterface } from "node:readline/promises";
import { AgenticDriver, type JsonObject } from "../src/index.js";
import { configuredProvider } from "./config.js";
const { provider, model } = configuredProvider();
if (!provider.info.capabilities.tools)
  throw new Error(
    "The selected real provider does not support application tools in this mode.",
  );

const proposals: JsonObject[] = [];
const driver = new AgenticDriver({
  providers: [provider],
  tools: [
    {
      name: "save_proposal",
      description: "Save a proposed brand name to this application's memory",
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
    provider: provider.info.id,
    model,
    input:
      "Propose one brand direction for AgenticDriver, an SDK connecting application developers to their own local and remote AI accounts. Preserve the name AgenticDriver. Save a concise title and rationale using save_proposal, subject to human review.",
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
