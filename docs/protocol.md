# Wire compatibility

The current wire version is **1.0**, independent of the SDK's package version.
`/v1` identifies the major endpoint family. TypeScript, Python, Go and Rust use
the same negotiation rules and send `AgenticDriver-Version: 1.0` on requests.

## Version selection

An authenticated `GET /v1/protocol` returns the selected `version`, the host's
`supportedVersions`, and its `features`. Clients expose this as `protocol()`
(Go: `Protocol(ctx)`). Responses include `AgenticDriver-Version`, including HTTP
errors. Browser hosts expose this header through CORS.

- An explicit unsupported or malformed request version produces HTTP 400 with
  `UNSUPPORTED_PROTOCOL_VERSION` before reading a run into provider execution.
- A successful response selecting an unsupported version is rejected by every
  client before consuming its result or stream. Clients never retry against a
  different version automatically.
- Omitting the request header selects the original 1.0 behavior. Older v0.1
  hosts may omit the response header; clients accept that legacy v1 contract.
  Explicit protocol discovery on a legacy host may return `NOT_FOUND`.
  Browser connections also require the host's CORS policy to allow negotiation
  headers; upgrade legacy hosts whose preflight policy does not allow them.
- A host adding another wire version must keep its earlier supported versions
  selectable, or declare a breaking support change. A client only requests
  versions it implements; package version numbers are not negotiated.

Within a selected wire version, hosts may add response fields and provider
capabilities without changing the meaning of existing fields. Consumers ignore
unknown response fields and preserve unknown error codes. Request objects stay
strict: unknown request fields are rejected rather than silently ignored.
New optional request fields must be supported by the target host; sending them
to an older host fails validation, with no implicit downgrade.

## Structured output schemas

`outputSchema` accepts synchronous, self-contained JSON Schema draft-07 or
2020-12. Omit `$schema` for draft-07, or declare
`https://json-schema.org/draft/2020-12/schema` for 2020-12 (including Zod 4's
default JSON Schema output). Each dialect is validated with its own rules;
2020-12 constraints such as `prefixItems` are enforced. External `$ref` loading
and asynchronous validators are unsupported and fail before model execution.
The driver validates returned JSON before emitting a completed result.

## Required capabilities

Provider discovery returns instance-specific boolean capabilities. Currently
`tools` means the application tool loop is supported and `textStreaming` means
visible text can arrive incrementally. A false flag must not be treated as a
supported feature. Additional flags can be introduced without changing clients.

Applications can put `requiredCapabilities: ["tools", "textStreaming"]` in a
run request. Every requested capability must be advertised as `true` by the
selected instance. Missing, false and unknown flags produce
`UNSUPPORTED_CAPABILITY` before any model call, tool action or run-start event.
Selecting application tools still performs the existing tool/model/allowlist
checks. Capability discovery never grants permission or selects a different
provider, model, account or billing mode.

Host `features` describe transport/runtime behavior; provider `capabilities`
describe a selected execution instance. Neither implies that a provider account
is currently signed in, healthy or within quota.

Hosts advertising `provider-discovery` add optional `health` and `modelCatalog`
fields to each authorized provider and accept `GET /v1/providers?refresh=true`.
See [account discovery](discovery.md) for caching, health states and probe limits.
The existing `models` field remains the host's allowlist; discovery is advisory.

## Events and extensions

Every wire event has a nonempty type and run ID, a timestamp and a positive
integer sequence. The wire sequence increases by one, including skipped advisory
events. All events belong to the same run. A successful run has exactly one
`run.completed`; unsuccessful execution has `run.failed` or `run.cancelled`.
A connection ending without a valid terminal event is never successful.
Applications accept the final result rather than treating intermediate text as
an accepted artifact. Cancellation cannot undo an external action already taken.

The shared [conformance suite](conformance.md) specifies byte limits, line-ending
handling, payload validation and transport failure cases for every client.

Current clients send `AgenticDriver-Accept-Optional-Events: true`. They validate
the envelope of an unfamiliar event, then skip it only when `optional` is the
boolean `true`. Unknown required types produce `UNSUPPORTED_EVENT`; malformed
or out-of-order envelopes still produce `INVALID_STREAM`. Known event types
are processed normally and never skipped merely because they are optional. Delivered
events can have sequence gaps when advisory events were skipped internally.

Hosts must not introduce unfamiliar event types to clients that omit this
opt-in. New advisory types may only carry information whose omission cannot
change execution, authorization, approvals, required progress or final outcomes.
New required state transitions need an explicitly negotiated feature or a new
wire version. There are no new advisory event types in the current host.

The original v0.1 clients are supported through their existing request shape and
event vocabulary. They need not understand the new discovery endpoint or
optional-event convention. `protocol/fixtures/versioning.json` captures legacy,
current and future-response examples consumed by the compatibility checks.

## Errors and recovery

Errors retain `{ code, message, retryable }`. Codes are stable identifiers;
messages may improve and are not suitable for branching. Unknown codes retain
their message and retryability and still represent failure. The `retryable`
flag describes a potentially transient condition, not permission to replay
side effects. Optional `outcome: "uncertain"` marks effects requiring reconciliation;
it is preserved even when the original error code is `IDLE_TIMEOUT` or `CANCELLED`.
The SDK retries only when explicitly requested through a supported provider's
`retry` policy. See [idempotency and recovery](idempotency.md) for accepted-key
deduplication, compact outcome replay, safe retry boundaries and storage guarantees.

| Codes                                                                                                                                                | Meaning                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`, `AUTH_REQUIRED`, `FORBIDDEN`, `ORIGIN_DENIED`                                                                                        | Missing credentials or denied driver access.                                                                  |
| `UNSUPPORTED_PROTOCOL_VERSION`, `UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_EVENT`                                                                        | Incompatible protocol, provider feature or required event.                                                    |
| `INVALID_REQUEST`, `INVALID_SCHEMA`, `UNKNOWN_PROVIDER`, `UNKNOWN_TOOL`, `UNSUPPORTED_MODEL`, `UNSUPPORTED_TOOLS`                                    | Request validation or unsupported configuration.                                                              |
| `BUSY`, `RATE_LIMITED`                                                                                                                               | Host or provider capacity; the application controls retry decisions.                                          |
| `CANCELLED`, `IDLE_TIMEOUT`, `TIMEOUT`                                                                                                               | Explicit cancellation, configured inactivity policy, or a separately bounded provider/housekeeping operation. |
| `PROVIDER_AUTH`, `PROVIDER_UNREACHABLE`, `PROVIDER_ERROR`, `PROVIDER_FAILED`, `PROVIDER_REFUSAL`, `INVALID_PROVIDER_RESPONSE`, `TRUNCATED_TOOL_CALL` | Provider authentication, transport, refusal or invalid output.                                                |
| `TOOL_NOT_ALLOWED`, `INVALID_TOOL_CALL`, `INVALID_TOOL_ARGUMENTS`, `APPROVAL_REQUIRED`, `TOOL_FAILED`                                                | A tool was denied, malformed, unapproved or failed.                                                           |
| `STEP_LIMIT`, `TOOL_LIMIT`, `TOOL_OUTPUT_LIMIT`, `OUTPUT_BUFFER_LIMIT`, `BODY_TOO_LARGE`, `RESPONSE_TOO_LARGE`                                       | An explicit resource bound was reached.                                                                       |
| `CLI_UNAVAILABLE`, `CLI_UPGRADE_REQUIRED`, `CLI_POLICY_VIOLATION`, `CLI_FAILED`, `CLI_OUTPUT_LIMIT`, `INVALID_CLI_OUTPUT`                            | Native runtime setup, policy, execution or output failure.                                                    |
| `INVALID_OUTPUT`, `INVALID_RESPONSE`, `INVALID_STREAM`, `INCOMPLETE_STREAM`                                                                          | Returned content or stream cannot be accepted.                                                                |
| `TLS_REQUIRED`, `INSECURE_TRANSPORT`                                                                                                                 | Unsafe transport configuration rejected.                                                                      |
| `NOT_FOUND`, `HTTP_ERROR`, `INTERNAL_ERROR`, `USAGESTAT_ERROR`, `USAGESTAT_SCHEMA`                                                                   | Endpoint, generic transport, internal or usage-integration failure.                                           |

There is **no default total run deadline and no default inactivity timeout**.
An application may set `idleTimeoutMs`; real model/tool work resets that policy,
while network pings do not. Negotiation/discovery connection bounds do not become
run deadlines. See [inactivity and cancellation](timeouts.md).

## Ingestion and retrieval extensions

Hosts advertising `scoped-retrieval` support `POST /v1/retrieval/search` and the
`retrieval` run option. `retrieval-indexing` adds explicit source index/delete
operations. `document-ingestion` adds `POST /v1/retrieval/ingest` using the token's
index grant; `pdf-ingestion` requires a configured PDF extractor. All operations
also require application corpus/source authorization. See [retrieval](retrieval.md)
and [ingestion](ingestion.md) for request shapes, provenance, bounds and errors.

Runs can emit `run.progress` with phase `context` while resolving sources or
performing retrieval. This is real work progress, subject to the same explicit
inactivity policy as model/tool work. Retrieval/ingestion mutation receipts
identify the exact corpus, source and revision. Unknown outcomes require
application reconciliation, with no automatic account, model or billing fallback.

## Interactive approvals extension

Hosts advertising `interactive-approvals` accept the explicit streaming
`approvals` run option and `POST /v1/approvals/decisions`. Only these opted-in
runs emit the required `approval.requested` and `approval.resolved` events.
Decisions require the originating subject plus provider and `approveTools`
grants, and identify the exact run and tool arguments. See
[interactive approvals](approvals.md) for lifecycle, audit, expiry and idle policy.

`APPROVAL_UNAVAILABLE`, `APPROVAL_POLICY`, `APPROVAL_STREAM_REQUIRED` and
`INVALID_APPROVAL` reject unsupported or malformed usage (HTTP 400).
`APPROVAL_NOT_FOUND` covers unknown, other-subject or consumed approvals (404);
`APPROVAL_MISMATCH` rejects altered bindings (409). Pending-capacity exhaustion
returns `APPROVAL_CAPACITY` (429), and failed audit recording returns
`APPROVAL_AUDIT_FAILED` (503). Run failures retain `APPROVAL_DENIED` or
`APPROVAL_EXPIRED`; cancellation retains `CANCELLED` or `IDLE_TIMEOUT`.

## Application tools extension

Hosts advertising `application-tools` accept `applicationTools` definitions on
streaming runs. Opted-in runs emit the required `tool.execution.requested` event
after argument validation and any required approval. Applications submit progress
to `POST /v1/tool-executions/progress` and one result to
`POST /v1/tool-executions/results`. Both require the originating subject, provider
and a separate `applicationTools` token grant. Bodies cannot supply authorization.
See [application-owned functions](application-tools.md) for binding APIs, limits,
process affinity and cancellation/reconciliation responsibilities.

`APPLICATION_TOOLS_UNAVAILABLE`, `TOOL_STREAM_REQUIRED`, `INVALID_TOOL_EXECUTION`,
`INVALID_TOOL_OUTPUT`, `TOOL_DEFINITION_LIMIT` and `TOOL_OUTPUT_LIMIT` reject
unsupported or malformed usage (HTTP 400). `TOOL_DEFINITION_CONFLICT` and
`TOOL_EXECUTION_MISMATCH` report conflicts (409); `TOOL_EXECUTION_NOT_FOUND` covers
unknown, consumed, cancelled or other-subject tickets (404).
`TOOL_EXECUTOR_CAPACITY` reports pending capacity exhaustion (429).
