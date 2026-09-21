import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AgenticClient } from "../src/client.js";
import type {
  ApprovalPolicy,
  ApprovalDecision,
} from "../src/approval-types.js";
import type {
  ApplicationToolDefinition,
  ToolExecutionIdentity,
  ToolExecutionResult,
} from "../src/tool-types.js";
import type { RetrievalRequest } from "../src/retrieval-types.js";
import { DriverError } from "../src/errors.js";

const reference = process.env.AGENTICDRIVER_TEST_REFERENCE_URL!;
const url = process.env.AGENTICDRIVER_TEST_URL!;
const token = process.env.AGENTICDRIVER_TEST_TOKEN!;
const fixtures = JSON.parse(
  await readFile(
    new URL("../protocol/fixtures/conformance.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    id: string;
    expectedError?: string;
    expectTransportError?: boolean;
    cancel?: boolean;
    operation?: string;
    retrieval?: RetrievalRequest;
    applicationTools?: ApplicationToolDefinition[];
    tools?: string[];
    toolIdentity?: ToolExecutionIdentity;
    toolResult?: ToolExecutionResult;
    approvals?: ApprovalPolicy;
    decision?: ApprovalDecision;
  }[];
};
const request = { provider: "mock", model: "demo", input: "Hello" };
const failures: string[] = [];
for (const example of fixtures.cases) {
  const client = new AgenticClient({
    url: `${reference}/fixtures/${example.id}`,
    token,
  });
  let failure: unknown;
  try {
    if (example.operation === "providers") await client.providers();
    else if (example.operation === "protocol") await client.protocol();
    else if (example.operation === "tool-result")
      await client.completeTool(example.toolResult!);
    else if (example.operation === "tool-progress")
      await client.reportToolProgress(example.toolIdentity!);
    else if (example.operation === "approval")
      await client.decideApproval(example.decision!);
    else if (example.operation === "ingest")
      await client.ingestContext({
        corpus: "library",
        document: {
          type: "reference",
          id: "paper",
          revision: "r1",
          mediaType: "text/markdown",
        },
      });
    else {
      let completed = false,
        cancelled = false;
      for await (const event of client.stream({
        ...request,
        approvals: example.approvals,
        applicationTools: example.applicationTools,
        tools: example.tools,
        ...(example.retrieval ? { retrieval: example.retrieval } : {}),
      })) {
        if (example.cancel && event.type === "text.delta") {
          cancelled = true;
          break;
        }
        if (event.type === "run.failed" || event.type === "run.cancelled")
          throw new DriverError(
            event.error.code,
            event.error.message,
            event.error.retryable,
          );
        if (event.type === "run.completed") {
          completed = true;
          assert.equal(event.result.text, "Hello 🌍");
        }
      }
      assert.ok(
        example.cancel ? cancelled : completed,
        "Missing expected outcome",
      );
    }
  } catch (error) {
    failure = error;
  }
  if (example.expectedError) {
    if (
      !(failure instanceof DriverError) ||
      failure.code !== example.expectedError
    )
      failures.push(
        `${example.id}: expected ${example.expectedError}, got ${String(failure)}`,
      );
  } else if (example.expectTransportError) {
    if (!failure)
      failures.push(`${example.id}: redirect unexpectedly succeeded`);
  } else if (failure) failures.push(`${example.id}: ${String(failure)}`);
}

const client = new AgenticClient({ url, token });
for (const action of ["approve", "deny", "cancel", "expire"] as const) {
  const events = [];
  for await (const event of client.stream({
    ...request,
    input: "conformance-approval",
    tools: ["approved_echo"],
    approvals: {
      mode: "interactive",
      idlePolicy: "pause",
      ...(action === "expire" ? { expiresAfterMs: 20 } : {}),
    },
  })) {
    events.push(event);
    if (event.type === "approval.requested" && action !== "expire") {
      const { approvalId, runId, call } = event.approval;
      const decision = { approvalId, runId, call, decision: action };
      assert.equal((await client.decideApproval(decision)).callId, call.id);
      await assert.rejects(client.decideApproval(decision), {
        code: "APPROVAL_NOT_FOUND",
      });
    }
  }
  assert.equal(
    events.at(-1)?.type,
    action === "approve"
      ? "run.completed"
      : action === "cancel"
        ? "run.cancelled"
        : "run.failed",
  );
  assert.equal(
    events.some((e) => e.type === "tool.completed"),
    action === "approve",
  );
  assert.equal(
    events.find((e) => e.type === "approval.resolved")?.resolution.outcome,
    {
      approve: "approved",
      deny: "denied",
      cancel: "cancelled",
      expire: "expired",
    }[action],
  );
}
const estimated = await client.run({ ...request, input: "conformance-cost" });
assert.equal(estimated.usage.apiEquivalentCostUsd, 0.25);
assert.equal(estimated.usage.costUsd, undefined);
await assert.rejects(
  new AgenticClient({ url, token: "wrong-token" }).run(request),
  { code: "UNAUTHORIZED" },
);
assert.deepEqual(
  await new AgenticClient({ url, token: token + "-restricted" }).providers(),
  [],
);
await assert.rejects(
  new AgenticClient({ url, token: token + "-restricted" }).run(request),
  { code: "FORBIDDEN" },
);
await assert.rejects(client.run({ ...request, tools: ["echo"] }), {
  code: "FORBIDDEN",
});
assert.equal(
  (await client.run({ ...request, input: "conformance-quiet" })).text,
  "AgenticDriver is connected.",
);
assert.equal(
  (
    await client.run({
      ...request,
      input: "conformance-progress",
      idleTimeoutMs: 150,
    })
  ).text,
  "AgenticDriver is connected.",
);
await assert.rejects(
  client.run({ ...request, input: "conformance-stall", idleTimeoutMs: 30 }),
  { code: "IDLE_TIMEOUT" },
);
if (url.startsWith("https:"))
  await assert.rejects(
    new AgenticClient({
      url: url.replace("127.0.0.1", "localhost"),
      token,
    }).providers(),
  );
assert.deepEqual(failures, [], "TypeScript conformance failures");
console.log(
  `TypeScript: ${fixtures.cases.length} wire cases, scoped auth, idle progress and TLS checks passed`,
);

// These functions exist only in the application process, not the execution host.
for (const requiresApproval of [false, true]) {
  let executed = 0,
    approved = false,
    completed = false;
  const applicationLookup = (input: Record<string, unknown>) => {
    executed++;
    return { passages: [`Evidence for ${input.query}`] };
  };
  for await (const event of client.stream({
    ...request,
    input: "conformance-application-tool",
    tools: ["application_lookup"],
    applicationTools: [
      {
        name: "application_lookup",
        description: "Find application-owned evidence",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          required: ["passages"],
          properties: {
            passages: { type: "array", items: { type: "string" } },
          },
        },
        requiresApproval,
      },
    ],
    ...(requiresApproval
      ? { approvals: { mode: "interactive", idlePolicy: "pause" } as const }
      : {}),
  })) {
    if (event.type === "approval.requested") {
      const { approvalId, runId, call } = event.approval;
      await client.decideApproval({
        approvalId,
        runId,
        call,
        decision: "approve",
      });
      approved = true;
    }
    if (event.type === "tool.execution.requested") {
      assert.equal(approved, requiresApproval);
      const execution = event.execution;
      const identity = {
        executionId: execution.executionId,
        runId: execution.runId,
        callId: execution.call.id,
      };
      const output = applicationLookup(execution.call.arguments);
      assert.equal(
        (await client.reportToolProgress(identity)).status,
        "progress",
      );
      assert.equal(
        (await client.completeTool({ ...identity, output })).status,
        "accepted",
      );
      await assert.rejects(client.completeTool({ ...identity, output }), {
        code: "TOOL_EXECUTION_NOT_FOUND",
      });
    }
    if (event.type === "run.failed" || event.type === "run.cancelled")
      assert.fail(event.error.code);
    if (event.type === "run.completed") completed = true;
  }
  assert.equal(executed, 1);
  assert.equal(completed, true);
}
