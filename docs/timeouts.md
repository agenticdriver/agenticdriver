# Inactivity and cancellation

AgenticDriver has **no default run deadline and no default inactivity timeout**.
Leaving `idleTimeoutMs` out, or setting it to `0`, allows a run to continue until
it completes, fails, reaches a step/output limit, or is explicitly cancelled.
Underlying providers and deployment infrastructure can still impose their own
connection or account limits.

An application can opt into an inactivity timeout:

```ts
const result = await driver.run({
  provider: "openai",
  model: "YOUR_MODEL",
  input: "Review the supplied evidence",
  idleTimeoutMs: 300_000, // This application stops after five minutes without progress.
});
```

This run may take hours if it keeps making progress. The timeout resets when the
provider emits visible text, reasoning or function-call updates, or when an
application tool reports actual progress or completes. The timer starts when
the run starts, so it also covers a stalled provider before its first output.
An expiry produces `IDLE_TIMEOUT` in a terminal `run.cancelled` event; `run()`
throws that typed error. Cancellation also interrupts upstream requests and CLI
processes. The SDK never retries potentially completed side effects automatically.

Long-running tools should report meaningful milestones:

```ts
async function execute(input, context) {
  const pages = [];
  for (const url of input.urls) {
    const response = await fetch(url, { signal: context.signal });
    pages.push(await response.text());
    context.reportProgress(); // A page was fetched and read.
  }
  return pages;
}
```

Do not call `reportProgress()` from a timer just to keep a job alive. Network
keepalives, empty deltas, provider pings, and stderr chatter do not reset the SDK
timer. Private reasoning contents stay inside the adapter; consumers receive
`run.progress` events with a `model` or `tool` phase. Progress notices may be
coalesced, but each underlying update resets the host's timer.

A host can enforce its own idle policy with
`limits: { idleTimeoutMs: 300_000 }`. A request may shorten that interval but
cannot disable or lengthen a positive host policy. Omitting the host setting, or
using zero, leaves the request in control. Valid intervals are integer
milliseconds up to 2,147,483,647; that ceiling is the timer's interval range, not
a cap on total run duration.

The same `idleTimeoutMs` field works over the wire in TypeScript, Python, Go
(`IdleTimeoutMs`), and Rust (`idle_timeout_ms`). The execution host measures real
activity; clients do not add a total run deadline. Catalog lookups, CLI feature
checks, TLS connection establishment, and telemetry delivery have separate
network/housekeeping timeouts. Explicit application abort signals or Go context
deadlines remain under the application's control.

With no configured timeout, an unresponsive provider remains pending until the
application cancels it. Applications own job lifecycle and operator controls;
disconnecting or closing an unfinished event stream also cancels that run.
