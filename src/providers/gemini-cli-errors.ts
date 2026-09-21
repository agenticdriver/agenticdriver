import { DriverError } from "../errors.js";

/** Inspect native diagnostics privately; return only fixed, actionable public text. */
export function geminiCliFailure(
  input: unknown,
  exitCode?: number | null,
): DriverError | undefined {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const type = typeof value?.type === "string" ? value.type : "";
  const message =
    typeof input === "string"
      ? input
      : typeof value?.message === "string"
        ? value.message
        : "";
  const code = value?.code ?? value?.status;
  if (
    value?.reasonCode === "UNSUPPORTED_CLIENT" ||
    /\bUNSUPPORTED_CLIENT\b/.test(message) ||
    /This client is no longer supported for Gemini Code Assist for individuals/i.test(
      message,
    )
  )
    return new DriverError(
      "CLI_AUTH_UNSUPPORTED",
      "Google rejected this Gemini CLI account route as unsupported. Configure an officially supported account/authentication route explicitly.",
    );
  if (
    ["TerminalQuotaError", "RetryableQuotaError"].includes(type) ||
    code === 429 ||
    /\b(?:TerminalQuotaError|RetryableQuotaError|RESOURCE_EXHAUSTED|rateLimitExceeded)\b/.test(
      message,
    )
  )
    return new DriverError(
      "RATE_LIMITED",
      "Gemini CLI reported an exhausted quota or rate limit for the selected account/model. Wait for its allowance to recover before retrying.",
      true,
    );
  if (
    type === "FatalAuthenticationError" ||
    exitCode === 41 ||
    code === 401 ||
    /\b(?:invalid_grant|invalid_rapt|UNAUTHENTICATED|FatalAuthenticationError)\b/.test(
      message,
    ) ||
    /Please set an Auth method in your .*settings\.json/i.test(message)
  )
    return new DriverError(
      "CLI_AUTH_REQUIRED",
      "Gemini CLI needs a valid sign-in for the selected account. Reauthenticate through the official CLI before retrying.",
    );
  if (
    type === "ModelNotFoundError" ||
    code === 404 ||
    /\bMODEL_NOT_FOUND\b/.test(message)
  )
    return new DriverError(
      "UNSUPPORTED_MODEL",
      "Gemini CLI cannot access the explicitly selected model. Choose an available model explicitly.",
    );
  if (type === "FatalCancellationError")
    return new DriverError("CANCELLED", "Gemini CLI cancelled the request.");
  return undefined;
}
