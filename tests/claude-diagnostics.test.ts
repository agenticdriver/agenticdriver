import assert from "node:assert/strict";
import test from "node:test";
import { claudeCliFailure } from "../src/providers/claude-cli-errors.js";

test("observed Claude native subscription-limit diagnostics have a private actionable code", () => {
  // Protocol fields recorded from the actual 2.1.282 Pro-account rejection on
  // 2026-09-29. No provider/model execution is substituted by these parser checks.
  const native = [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        overageStatus: "rejected",
        isUsingOverage: false,
        resetsAt: 1790694600,
      },
    },
    { type: "assistant", error: "rate_limit" },
    {
      type: "result",
      is_error: true,
      result:
        "You've hit your session limit · resets 5:10pm (Europe/Amsterdam)",
    },
  ];
  for (const input of native) {
    const error = claudeCliFailure(input);
    assert.equal(error?.code, "RATE_LIMITED");
    assert.equal(error?.retryable, true);
    assert.doesNotMatch(
      error?.message ?? "",
      /5:10pm|Europe\/Amsterdam|1790694600/,
    );
  }
});

test("successful text, quota warnings and unrelated diagnostics are not terminal failures", () => {
  for (const input of [
    null,
    "rate_limit",
    {
      type: "assistant",
      message: { content: "You've hit your session limit" },
    },
    {
      type: "result",
      is_error: false,
      result: "You've hit your session limit",
    },
    { type: "result", is_error: true, result: "An unknown native failure" },
    { type: "assistant", error: "unknown" },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
    },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        overageStatus: "allowed",
        isUsingOverage: true,
      },
    },
  ])
    assert.equal(claudeCliFailure(input), undefined);
});
