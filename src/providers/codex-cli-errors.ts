import { DriverError } from "../errors.js";

/** Recognize native diagnostics privately; never expose their bodies or URLs. */
export function codexCliFailure(input: unknown): DriverError | undefined {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const message =
    typeof input === "string"
      ? input
      : typeof value?.message === "string"
        ? value.message
        : "";
  // These prefixes are emitted by the native CLI, not arbitrary model output.
  // A number or an error phrase embedded in an unknown diagnostic is insufficient.
  if (
    /^unexpected status 401\b/i.test(message) ||
    /^Your access token could not be refreshed(?: because your refresh token (?:has expired|was already used|was revoked))?\. Please log out and sign in again\.$/.test(
      message,
    )
  )
    return new DriverError(
      "CLI_AUTH_REQUIRED",
      "Codex CLI needs a valid sign-in for the selected account. Reauthenticate through the official CLI before retrying.",
    );
  if (
    /^(?:unexpected status 429\b|exceeded retry limit, last status: 429\b)/i.test(
      message,
    )
  )
    return new DriverError(
      "RATE_LIMITED",
      "Codex CLI reported a rate limit for the selected account/model. Wait for its allowance to recover before retrying.",
      true,
    );
  if (
    /^unexpected status 404\b[^\n]*: The model\b[^\n]*does not exist\b/i.test(
      message,
    )
  )
    return new DriverError(
      "UNSUPPORTED_MODEL",
      "Codex CLI cannot access the explicitly selected model. Choose an available model explicitly.",
    );
  return undefined;
}
