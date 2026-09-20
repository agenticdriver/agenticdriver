import { DriverError } from "./errors.js";

/** Wire versions are independent of npm, PyPI, Go module and crate versions. */
export const PROTOCOL_VERSION = "1.0";
export const PROTOCOL_VERSION_HEADER = "AgenticDriver-Version";
export const OPTIONAL_EVENTS_HEADER = "AgenticDriver-Accept-Optional-Events";
export const RUN_EVENT_TYPES = [
  "run.started",
  "step.started",
  "text.delta",
  "run.progress",
  "tool.called",
  "tool.completed",
  "usage.reported",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export interface ProtocolInfo {
  protocol: "agenticdriver";
  version: string;
  supportedVersions: string[];
  features: string[];
}

export function protocolInfo(
  options: { idempotency?: boolean } = {},
): ProtocolInfo {
  return {
    protocol: "agenticdriver",
    version: PROTOCOL_VERSION,
    supportedVersions: [PROTOCOL_VERSION],
    features: [
      "json-results",
      "event-stream",
      "cancel-on-disconnect",
      "optional-idle-timeout",
      "required-capabilities",
      "optional-events",
      "provider-discovery",
      ...(options.idempotency ? ["idempotency"] : []),
    ],
  };
}

/** An absent header is the original v1 contract, for pre-negotiation clients. */
export function negotiateProtocolVersion(value?: string | string[]): string {
  if (value === undefined || value === PROTOCOL_VERSION)
    return PROTOCOL_VERSION;
  throw new DriverError(
    "UNSUPPORTED_PROTOCOL_VERSION",
    "The requested wire protocol version is not supported; this host supports 1.0.",
  );
}

/** Legacy v1 hosts may omit the header. Explicit incompatible versions fail closed. */
export function checkResponseVersion(value: string | null): void {
  if (value !== null && value !== PROTOCOL_VERSION)
    throw new DriverError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "The host selected an unsupported wire protocol version.",
    );
}
