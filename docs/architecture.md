# Architecture

AgenticDriver separates the application, runtime, adapter, and transport.

The application owns users, domain data, retrieval, workflow checkpoints,
approval UI, and accepted artifacts. It injects explicitly registered tools and
can compose runs into sequential or concurrent workflows. The SDK does not own
an application's database or replace its workflow engine.

The runtime validates a request, selects a configured provider instance, applies
host limits, and runs model/tool/result steps. JSON Schema validates tool input
and optional output. All arguments in a tool batch are checked before execution;
tool side effects execute serially. A tool requiring approval fails closed unless
the host supplies a positive approval decision. There are no automatic retries,
including after tool side effects.

An adapter owns authentication and vendor protocol translation. Each instance
has its own stable ID and optional model allowlist. Capabilities describe actual
implementation support. API adapters share the runtime's application-tool loop;
local CLI adapters currently return text from their own restricted native runtime.
New vendors implement `ProviderAdapter` without changing the client protocol.

The transport exposes `GET /v1/providers` and `POST /v1/runs` over HTTP on loopback
or HTTPS remotely. The latter returns JSON or SSE according to `Accept`. The
protocol is described in [OpenAPI](../protocol/openapi.json); regenerate request
schemas with `npm run protocol` after contract changes.

## Authentication and execution ownership

A driver token identifies a trusted `subject` and exact provider/tool allowlists.
Requests contain provider IDs, model IDs, context, and selected tool names. They
cannot specify credentials, shell commands, executable paths, environment
variables, or a different authenticated subject. Metadata is untrusted labeling
and must never grant access.

Provider credentials stay on the execution machine. To support users bringing
their own subscriptions, place the host on their device or in their dedicated
environment. To use server-owned API credentials, register instances on the
application's execution server. For multiple accounts with local CLIs, separate
process users or containers provide the meaningful filesystem boundary.

The v0.1 token registry is configured at startup. Applications needing expiring
device credentials, browser pairing, OAuth, token rotation without restart, or
an outbound relay must add those control-plane services. A hosted browser cannot
automatically reach a laptop; use a reachable authenticated HTTPS endpoint or a
trusted tunnel. There is no hidden relay or browser session scraping.

Browser origins are denied by default. Hosts may configure an exact
`allowedOrigins` list, but bearer authentication is still mandatory. Clients
reject non-loopback plaintext HTTP and credential-bearing URLs and disable
redirect following. TLS verification remains enabled.

## Events, limits, and cancellation

Every run has a host-generated ID, ordered event sequence, and timestamps. It
ends with `run.completed`, `run.failed`, or `run.cancelled`. Text events may
contain intermediate model output; `result.text` is the final model response.
Consumers must wait for a terminal event before accepting an artifact. JSON
results with `finishReason: "length"` require application treatment as truncated.

There is no total run deadline and no inactivity timeout by default. Applications
can set `idleTimeoutMs` on a request or host. Actual text, reasoning/function-call
updates, tool completion, and `context.reportProgress()` reset the inactivity
timer. SSE comments and provider pings never count as progress. See
[timeout semantics](timeouts.md), including host-enforced idle policies.

The default maximum is eight model steps. Protocol maxima are 64 steps,
32 selected tools, and 65,536 API output tokens per step. Hosts can lower these
limits. Request bodies and tool output are bounded to 1 MB; a JSON response or
SSE frame to 2 MB; an upstream SSE response to 10 MB. The pending event queue is
bounded and cancels a run if a consumer falls too far behind. The default host
permits 32 concurrent runs and four per authenticated subject.

Timeouts and client disconnection abort upstream HTTP requests and terminate CLI
process groups. The runtime stops awaiting a noncooperative application tool at
inactivity timeout or explicit cancellation, but cannot kill arbitrary JavaScript. Tool implementations must
observe the signal and enforce idempotency/transaction semantics in their own
storage. Cancellation does not undo a completed external action.

The host holds no durable job state and does not replay disconnected runs.
Applications should add a durable queue around the SDK if they need resumable
literature reviews or background inbox processing. Multimodal content, MCP
bridges, distributed scheduling, and provider failover
are future extensions, not advertised v0.1 capabilities.

## Usage

Per-step events report provider-supplied token and optional cost measurements.
Final totals are omitted for a measurement if any step lacks it, rather than
presenting a partial total as complete. `onUsage` receives a prompt-free record
with run ID, trusted subject, provider instance, model, status, duration, usage,
and application labels. A sink failure does not cause a successful run to retry.
The built-in JSONL sink is append-only and intended for one execution process;
a central metering service should deduplicate by run ID.
