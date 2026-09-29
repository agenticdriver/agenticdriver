// Qualify approval/executor boundaries using an actual native model proposal.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connectedClient } from "@agenticdriver/sdk/connections";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    foreign: { type: "string" },
    restricted: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    document: { type: "string" },
    receipt: { type: "string" },
    mode: { type: "string" },
  },
});
for (const name of [
  "owner",
  "foreign",
  "restricted",
  "provider",
  "model",
  "document",
  "receipt",
  "mode",
])
  if (!values[name]) throw new Error(`Provide --${name}.`);
assert(["accept", "deny", "disconnect"].includes(values.mode));
const file = await open(values.receipt, "wx", 0o600);
const receipt = {
  startedAt: new Date().toISOString(),
  mode: values.mode,
  events: {},
  checks: {},
  documentReads: 0,
};
const controller = new AbortController();
try {
  const owner = await connectedClient(values.owner),
    foreign = await connectedClient(values.foreign),
    restricted = await connectedClient(values.restricted);
  const provider = (await owner.providers({ refresh: true })).find(
    (item) => item.id === values.provider,
  );
  assert(
    provider?.capabilities.tools &&
      provider.connection?.account?.status === "signed-in" &&
      provider.modelCatalog?.source === "provider" &&
      provider.modelCatalog.models.includes(values.model),
  );
  if (provider.models) assert(provider.models.includes(values.model));
  receipt.selection = {
    provider: provider.id,
    model: values.model,
    authMode: provider.authMode,
    runtime: provider.connection.runtime,
    subscription: provider.connection.account.subscription,
  };
  const definition = {
    name: "read_release_note",
    description:
      "Read the application's explicitly selected public AgenticDriver release criteria. The only available sourceId is release-criteria. This tool cannot send messages, read other files or change settings.",
    inputSchema: {
      type: "object",
      properties: { sourceId: { const: "release-criteria" } },
      required: ["sourceId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        sourceId: { const: "release-criteria" },
        text: { type: "string" },
      },
      required: ["sourceId", "text"],
      additionalProperties: false,
    },
  };
  const request = {
    provider: values.provider,
    model: values.model,
    input:
      "Use the read_release_note application tool exactly once with sourceId release-criteria, then write a concise release-review checklist grounded only in that note. Identify which platform and account modes are in scope and what evidence is still needed. Do not browse, run commands or use any other tool. Reading this explicitly selected public note is authorized; follow the application's approval result.",
    tools: [definition.name],
    applicationTools: [definition],
    approvals: { mode: "interactive", idlePolicy: "continue" },
    idempotencyKey: `rc-tools-${randomUUID()}`,
    retry: { maxAttempts: 1 },
    maxSteps: 3,
  };
  receipt.request = request;
  let terminal;
  try {
    for await (const event of owner.stream(request, {
      signal: controller.signal,
    })) {
      receipt.events[event.type] = (receipt.events[event.type] ?? 0) + 1;
      if (event.type === "run.started") receipt.runId = event.runId;
      if (event.type === "approval.requested") {
        assert.equal(
          receipt.events[event.type],
          1,
          "Only one approved read is in this validation's scope.",
        );
        receipt.approval = event.approval;
        const decision = {
          approvalId: event.approval.approvalId,
          runId: event.approval.runId,
          call: event.approval.call,
          decision: values.mode === "deny" ? "deny" : "approve",
        };
        assert.deepEqual(decision.call.arguments, {
          sourceId: "release-criteria",
        });
        await assert.rejects(foreign.decideApproval(decision), {
          code: "APPROVAL_NOT_FOUND",
        });
        await assert.rejects(restricted.decideApproval(decision), {
          code: "FORBIDDEN",
        });
        await assert.rejects(
          owner.decideApproval({
            ...decision,
            call: {
              ...decision.call,
              arguments: { sourceId: "unselected-source" },
            },
          }),
          { code: "APPROVAL_MISMATCH" },
        );
        receipt.checks.approvalSubjectScopeAndArguments = true;
        receipt.resolution = await owner.decideApproval(decision);
        await assert.rejects(owner.decideApproval(decision), {
          code: "APPROVAL_NOT_FOUND",
        });
        receipt.checks.approvalReplayRejected = true;
      }
      if (event.type === "tool.execution.requested") {
        assert.notEqual(values.mode, "deny");
        assert.equal(receipt.events[event.type], 1);
        receipt.execution = event.execution;
        const { executionId, runId, call } = event.execution;
        assert.equal(call.name, "read_release_note");
        assert.deepEqual(call.arguments, { sourceId: "release-criteria" });
        const identity = { executionId, runId, callId: call.id };
        await assert.rejects(foreign.reportToolProgress(identity), {
          code: "TOOL_EXECUTION_NOT_FOUND",
        });
        await assert.rejects(restricted.reportToolProgress(identity), {
          code: "FORBIDDEN",
        });
        await assert.rejects(
          owner.reportToolProgress({ ...identity, runId: randomUUID() }),
          { code: "TOOL_EXECUTION_MISMATCH" },
        );
        receipt.checks.executorSubjectScopeAndRun = true;
        await owner.reportToolProgress(identity);
        const output = {
          sourceId: "release-criteria",
          text: await readFile(values.document, "utf8"),
        };
        receipt.documentReads++;
        if (values.mode === "disconnect") {
          controller.abort();
          break;
        }
        receipt.executionReceipt = await owner.completeTool({
          ...identity,
          output,
        });
        await assert.rejects(owner.completeTool({ ...identity, output }), {
          code: "TOOL_EXECUTION_NOT_FOUND",
        });
        receipt.checks.resultReplayRejected = true;
      }
      if (event.type === "run.completed") {
        receipt.result = event.result;
        terminal = "completed";
      }
      if (event.type === "run.failed" || event.type === "run.cancelled") {
        receipt.terminalError = event.error;
        terminal = event.type;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  assert(
    receipt.approval,
    "The actual model must propose the application tool.",
  );
  if (values.mode === "accept") {
    assert.equal(terminal, "completed");
    assert.equal(receipt.documentReads, 1);
    assert(receipt.result.text.trim());
    const replay = [];
    for await (const event of owner.stream(request)) replay.push(event);
    // Historical step/usage records are observations; executable tickets and
    // approval requests must never be reissued by recovery.
    assert(
      !replay.some((event) =>
        ["approval.requested", "tool.execution.requested"].includes(event.type),
      ),
    );
    assert.equal(
      replay.find((event) => event.type === "run.completed")?.result.runId,
      receipt.runId,
    );
    receipt.checks.completedReplayWithoutEffects = true;
  } else if (values.mode === "deny") {
    assert.equal(receipt.terminalError?.code, "APPROVAL_DENIED");
    assert.equal(receipt.documentReads, 0);
    assert.equal(receipt.events["tool.execution.requested"], undefined);
    receipt.checks.denialBeforeApplicationEffect = true;
  } else {
    assert(controller.signal.aborted && receipt.execution);
    receipt.checks.disconnectedWithUnconfirmedRead = true;
  }
  receipt.success = true;
  console.log(
    JSON.stringify({
      success: true,
      mode: values.mode,
      runId: receipt.runId,
      checks: receipt.checks,
      documentReads: receipt.documentReads,
      usage: receipt.result?.usage,
    }),
  );
} catch (error) {
  controller.abort();
  receipt.success = false;
  receipt.error = { code: error.code, message: error.message };
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  await file.close();
}
