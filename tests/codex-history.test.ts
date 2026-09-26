import assert from "node:assert/strict";
import test from "node:test";
import { codexHistory } from "../src/providers/codex-history.js";
import type { ProviderRequest } from "../src/types.js";

test("Codex continuation uses native roles and call/result pairs, without replaying the user's command", () => {
  const request: ProviderRequest = {
    model: "fixture",
    tools: [],
    maxOutputTokens: 100,
    instructions: "Application instructions",
    messages: [
      { role: "user", content: "Call once then return the result." },
      {
        role: "assistant",
        content: "Checking",
        toolCalls: [
          { id: "first", name: "lookup", arguments: { key: "selected" } },
          { id: "second", name: "lookup", arguments: { key: "other" } },
        ],
        native: { private: "not-history" },
      },
      {
        role: "tool",
        name: "lookup",
        callId: "first",
        content: '{"answer":"one"}',
      },
      {
        role: "tool",
        name: "lookup",
        callId: "second",
        content: '{"answer":"two"}',
      },
    ],
  };
  const result = codexHistory(request, "owned");
  assert.equal(
    result.input,
    "Continue from the completed tool results in this conversation.",
  );
  assert.deepEqual(result.items, [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: request.instructions }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request.messages[0]!.content }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking" }],
    },
    {
      type: "function_call",
      call_id: "first",
      name: "mcp__owned__lookup",
      arguments: '{"key":"selected"}',
    },
    {
      type: "function_call",
      call_id: "second",
      name: "mcp__owned__lookup",
      arguments: '{"key":"other"}',
    },
    {
      type: "function_call_output",
      call_id: "first",
      output: '{"answer":"one"}',
    },
    {
      type: "function_call_output",
      call_id: "second",
      output: '{"answer":"two"}',
    },
  ]);
  request.messages.push({ role: "user", content: "Follow-up question" });
  const followup = codexHistory(request, "owned");
  assert.equal(followup.input, "Follow-up question");
  assert.deepEqual(followup.items, result.items);
});
