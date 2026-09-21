# Scheduling and resource policies

Admission uses the authenticated subject and the host's explicit account binding.
Requests cannot set either identity, concurrency limits or spend policies. A host
never switches the selected provider, account or model to obtain capacity.

```ts
const driver = new AgenticDriver({
  providers,
  usage: {
    hostId: "installation-one",
    accounts: { personal: "account-one", personalAlias: "account-one" },
  },
  scheduling: {
    total: 16,
    perSubject: 2,
    perAccount: 4,
    subjects: { "review-worker": 3 },
    accounts: { "account-one": 2 },
    queue: { total: 100, perSubject: 10 },
  },
  resources: {
    default: { maxTokens: 40_000, unknownUsage: "reject" },
    subjects: {
      "review-worker": { maxTokens: 20_000, unknownUsage: "reject" },
    },
    accounts: { "account-one": { maxCostUsd: 0.5, unknownUsage: "reject" } },
  },
});
```

`providers` are explicitly configured adapters. In embedded mode the application
supplies a trusted `subject` in `RunOptions`. A remote server derives it from its
token mapping. Account aliases share capacity by `(hostId, accountId)`, across
subjects and provider instance names. Account policies require real host/account
bindings; unbound generation fails instead of being assigned an invented account.

Concurrency defaults on an HTTP host are 32 total and 4 per subject. Embedded
execution has no scheduler unless `scheduling` is configured. Per-subject/account
overrides replace their corresponding default, while the global cap still applies.
`resources` budgets intersect: the default, account and subject limits all apply.
These optional guards do not create a default cost/token budget or execution timer.

Configure scheduling once, either in `AgenticDriver({ scheduling })` or
`serve(driver, { scheduling })`. A server automatically shares a driver's configured
scheduler, including with embedded calls to that driver. Supplying conflicting
locations or mixing `scheduling` with legacy `maxConcurrentRuns` options is rejected.
The host JSON uses `concurrency` for these scheduling options and `resources` for
observed budgets. Its JSON configuration cannot contain executable policy callbacks.

## Queue behavior

Queueing is opt-in. With no `queue`, saturation returns retryable `BUSY` (HTTP 429).
A configured queue has separate total and per-subject bounds. Full queues return
retryable `QUEUE_FULL` (HTTP 429). Choose per-subject concurrency and queue bounds
below the global bounds to reserve room for other tenants. Multiple bearer tokens
for one subject share its limits; only a trusted host can introduce another subject.

When slots become free, queued subjects rotate in round-robin order. Each rotation
admits one eligible request for a subject, preserving arrival order among requests
whose account has capacity. A blocked account does not block another account's work.
An admitted tenant's backlog cannot indefinitely overtake another eligible queued
tenant. Saturation can still reject new work; this is a bounded process-local queue,
not a durable job service or a guarantee of admission for every incoming request.

Running work is not preempted. A provider that never completes can keep a slot until
the application cancels it. No execution deadline is invented to improve fairness.
Cancellation immediately removes a queued ticket; disconnect and host shutdown
cancel pending and active work. Arbitrary in-process adapters/tools must cooperate
with their abort signal: the SDK cannot undo external effects or forcibly terminate
JavaScript that ignores cancellation. A restart loses waiting work. Multiple host
processes need an external scheduler/authority for installation-wide limits.

For SSE, `run.started` means the run was accepted; it may still be waiting for
execution capacity. Headers and that event arrive before the wait. No model step
or tool starts while waiting, and no fabricated progress events reset an activity
clock. Queue waits and resource-authority waits do not start/consume a configured
model inactivity interval. The clock resumes when execution begins. JSON callers
wait for the result as usual. Clients add no queue deadline; application cancellation
remains available in every language.

Retrieval/index/ingestion endpoints share the host and subject execution caps, but
their embedding accounts are configured separately and are not inferred from a
generation account. Provider discovery, approval decisions, application-tool
progress/results and session create/read/delete do not take execution slots.
These controls remain available when generation is full. An idempotent replay
does not execute the provider or reissue resource authorization; remote admission
can still reject a replay when its waiting queue is saturated.

The exported `FairScheduler` supports custom trusted hosts. `submit(identity,
signal)` returns a ticket; await `ticket.wait()` before work and always call
`ticket.release()` in `finally`. Queued tickets have no expiry. `stats` reports only
active/queued counts. `RunOptions.admission` is a trusted transport hook used by the
built-in server, never a field accepted from a remote run request.

## Observed per-run budgets

`maxTokens` is the sum of all reported input and output tokens across model steps.
Cached/reasoning subsets are not added twice. `maxCostUsd` uses reported `costUsd`
only; API-equivalent subscription estimates are never treated as spend. Generation
budgets exclude embedding calls and application/tool expenses, which retain their
own accounting. Neither field is a monthly or account-wide balance.

Every configured budget states `unknownUsage: "reject" | "allow"`. A missing,
invalid or partially reported required measurement stays unknown. `reject` stops
after the first response that cannot establish the guarded total. `allow` permits
continued work with that uncertainty; it does not manufacture a zero or total.
Known subtotals and overflowing reported totals still stop work when they exceed
the cap, under either policy. Telemetry retains coverage and observed subtotals.

The guard runs after every model response, before dispatching its tools or starting
another step. A final response at exactly the cap can complete; further work at the
cap is rejected. The remaining known token allowance also lowers the next model's
output-token request. Input tokens cannot be predicted exactly, and an in-flight
response can exceed the allowance. **These are observed limits, not guaranteed
billing ceilings.** Text may already have streamed before a budget failure; it is
provisional until `run.completed`. Costs already incurred are not refunded.

`RESOURCE_LIMIT` or `RESOURCE_USAGE_UNKNOWN` terminates the run without automatic
retry. If earlier tools ran, their completed effects remain; reconcile the recorded
operation rather than starting a replacement under another key. Stored conversation
sessions become interrupted after generation begins, just as for other failed turns.

## Reuse Usagestat for account quota admission

Usagestat remains the dependency for quota probes and durable metering. The SDK
does not add a usage database, price table, spend ledger or offline outbox.

```ts
import { UsageStatClient } from "agenticdriver/usagestat";

const usage = new UsageStatClient({
  url: "http://127.0.0.1:6736",
  token: process.env.USAGESTAT_TOKEN!,
  accounts: [
    {
      hostId: "installation-one",
      provider: "personal",
      accountId: "account-one",
      instanceId: "upstream-personal",
      subjects: ["alice"],
    },
  ],
});

const driver = new AgenticDriver({
  providers,
  usage: { hostId: "installation-one", accounts: { personal: "account-one" } },
  onUsage: usage.usageSink(),
  resourceAdmission: usage.quotaAdmission({
    resource: "tokens", // Choose an actual resource key from this account's limits.
    unit: "tokens", // Its unit must match exactly.
    minimumRemaining: 1_000,
    maxAgeMs: 60_000,
    unknown: "reject",
  }),
});
```

Before each model step, the helper reads the existing scoped `/v1/limits/{instance}`
API. Stale/future timestamps, elapsed reset windows, wrong units, missing remaining
values, invalid snapshots and backend failures produce an unknown decision.
The configured `unknown` policy determines whether that observation allows work.
Exhausted quota denies admission. Missing account authorization always fails closed.
Cancellation propagates to the quota read; the existing ten-second backend I/O
watchdog is separate from execution and scheduling waits.

This helper is a read-only snapshot guard. Its remaining threshold is a minimum
for starting a step, not an estimate of the step's consumption. Concurrent runs
can observe the same quota and upstream observations can lag. It does not reserve
funds or provide a hard shared spend cap.

For an application with an atomic account-wide allowance service, supply
`resourceAdmission: { unknown: "reject", authorize(context) }`. The callback receives
trusted identity, run ID, model, proposed step, usage/coverage so far and an abort
signal, without prompts or credentials. It returns `"allow"`, `"deny"` or `"unknown"`.
Exceptions and invalid decisions fail closed as `RESOURCE_POLICY_UNAVAILABLE`;
callback errors are not sent to clients. Use `(hostId, runId, step)` as an external
reservation identity, and reconcile/settle in that backend using the usage sink.
A reservation may remain uncertain after cancellation or failed delivery; the SDK
does not silently release it or repeat a charged operation. Custom hooks own
their network watchdogs and should honor cancellation.

| Error                         | HTTP | Application action                                                 |
| ----------------------------- | ---- | ------------------------------------------------------------------ |
| `BUSY`, `QUEUE_FULL`          | 429  | Back off or wait for capacity on the selected host/account.        |
| `ADMISSION_IDENTITY_REQUIRED` | 503  | Configure trusted host/account bindings.                           |
| `RESOURCE_ADMISSION_DENIED`   | 403  | Review the account or subject allowance.                           |
| `RESOURCE_USAGE_UNKNOWN`      | 403  | Refresh/reconcile measurements or explicitly change policy.        |
| `RESOURCE_LIMIT`              | 403  | Reconcile incurred usage and prior effects; do not blindly replay. |
| `RESOURCE_POLICY_UNAVAILABLE` | 503  | Restore the authority and reconcile any reservation.               |

After SSE headers, policy failures use the same typed error in `run.failed`.
All language clients preserve these error codes. None automatically selects a
different provider or retries a budget failure.
