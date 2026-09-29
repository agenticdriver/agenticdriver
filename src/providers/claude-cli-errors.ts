import { DriverError } from "../errors.js";

/** Classify native protocol diagnostics, never ordinary assistant text. */
export function claudeCliFailure(input: unknown): DriverError | undefined {
  if (!input || typeof input !== "object") return undefined;
  const event = input as Record<string, unknown>;
  const info =
    event.rate_limit_info && typeof event.rate_limit_info === "object"
      ? (event.rate_limit_info as Record<string, unknown>)
      : undefined;
  if (
    (event.type === "rate_limit_event" &&
      info?.status === "rejected" &&
      info.overageStatus === "rejected" &&
      info.isUsingOverage === false) ||
    (event.type === "assistant" && event.error === "rate_limit") ||
    (event.type === "result" &&
      event.is_error === true &&
      typeof event.result === "string" &&
      /^You've hit your session limit\b/.test(event.result))
  )
    return new DriverError(
      "RATE_LIMITED",
      "Claude Code reported an exhausted allowance for the selected account/model. Wait for its allowance to recover before retrying; the native CLI shows the reset time.",
      true,
    );
  return undefined;
}
