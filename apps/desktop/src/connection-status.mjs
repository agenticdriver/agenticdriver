import { connectionTarget } from "@agenticdriver/sdk/client";

/** Local parsing only: the one-use credential never appears in the response. */
export function invitationPreview(invitation) {
  const { url } = connectionTarget(invitation);
  const target = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    target.hostname,
  );
  return {
    url,
    suggestedLabel: target.host,
    location: loopback ? "this-computer" : "remote",
    transport: target.protocol === "https:" ? "https" : "loopback",
  };
}

/** Classify known codes without exposing upstream bodies, URLs or native errors. */
export function connectionFailure(error) {
  if (error?.code === "CONNECTION_EXPIRED")
    return {
      status: "expired",
      message:
        "This connection expired. Reconnect with a new invitation from the same host.",
    };
  if (["UNAUTHORIZED", "FORBIDDEN", "AUTH_REQUIRED"].includes(error?.code))
    return {
      status: "rejected",
      message:
        "The host rejected this credential. Ask its operator for a new invitation, then reconnect.",
    };
  if (["CONNECTION_REQUIRED", "AUTH_UNAVAILABLE"].includes(error?.code))
    return {
      status: "credential-unavailable",
      message:
        "The saved credential could not be read. Reconnect with a new invitation from the same host.",
    };
  if (
    ["UNSUPPORTED_PROTOCOL_VERSION", "INVALID_RESPONSE"].includes(error?.code)
  )
    return {
      status: "incompatible",
      message:
        "This address did not return a compatible AgenticDriver host. Check the address, proxy path and host version.",
    };
  if (error?.code === "HOST_STOPPED")
    return {
      status: "stopped",
      message: "Start the local host, then check the connection again.",
    };
  const codes = new Set();
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    if (typeof current.code === "string") codes.add(current.code);
    if (current.name === "TimeoutError" || current.name === "AbortError")
      codes.add("TIMEOUT");
  }
  if (
    [
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].some((code) => codes.has(code))
  )
    return {
      status: "certificate",
      message:
        "The host's TLS certificate could not be verified. Check its hostname, certificate chain and trusted CA; verification remains enabled.",
    };
  if (codes.has("TIMEOUT"))
    return {
      status: "unreachable",
      message:
        "The host did not answer the connection check. Check the network or tunnel, then try again. Model runs were not cancelled.",
    };
  return {
    status: "unreachable",
    message:
      "The host could not be reached. Check that it is running and that its address or secure tunnel is reachable from this computer.",
  };
}
