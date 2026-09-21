# Optional operational diagnostics

An embedded runtime or custom execution host can attach `Diagnostics` to observe
run admission, context processing, provider calls, tools, real progress and final
outcomes. Nothing is exported unless the host installs an exporter. The stock CLI
does not create a telemetry connection. Token and billing accounting continue to
use [Usagestat](usagestat.md); diagnostics do not create another usage backend.

```ts
import { AgenticDriver } from "agenticdriver";
import { Diagnostics } from "agenticdriver/diagnostics";

const diagnostics = new Diagnostics({
  level: "steps",
  correlation: { requestIdMetadataKey: "requestId" },
  exporter: {
    async export(records, { signal }) {
      // Send only these constructed records through your bounded logging client.
      await applicationLogger.write(records, { signal });
    },
  },
});
const driver = new AgenticDriver({ providers, diagnostics });
await driver.run({
  provider: selectedProvider,
  model: selectedModel,
  input: prompt,
  metadata: { requestId: crypto.randomUUID() },
});
// Drain active runs and close your HTTP host before closing diagnostics.
await diagnostics.close();
```

`configuredDriver(config, { diagnostics })` provides the same integration for a
custom host using the normal validated configuration. The runnable
[installed package example](../examples/javascript/diagnostics.mts) needs no
credentials or OpenTelemetry packages.

## Content and correlation

Records are constructed from a fixed allowlist. They omit prompts, visible
answers, private reasoning, native provider state, tool arguments/results,
source passages, credentials, exception messages, account/subject identities,
request paths and arbitrary metadata. `includeNames: true` adds the configured
provider/model and tool names; the default is false. Keep names free of private
data before opting in. No verbosity level enables content logging.

Each run observation includes its opaque run ID and a new observation UUID.
An idempotent replay keeps the original run ID, uses a separate observation ID,
and reports `replayed` without provider or tool execution. Partial replay that
the caller abandons before receiving a terminal event reports `cancelled`.
Failures before run admission/validation do not produce a run record; an HTTP
host still records the rejected request without its body or error message.

Request correlation is explicit: configure metadata keys, pass the host-only
`RunOptions.diagnostics` fields, or enable `serve(driver, { diagnosticHeaders:
true, ... })`. The last option accepts `AgenticDriver-Request-Id` and
`traceparent`. Request IDs must be UUIDs. Trace parents must be W3C version 00
with nonzero trace/span IDs and flags 00 or 01. Other values are discarded.
Correlation is untrusted metadata, never an authentication or authorization
decision. Baggage and tracestate are not forwarded. Headers stay opt-in and are
not persisted into detached jobs; explicit metadata correlation survives job
storage when configured. Run and HTTP observations share correlation rather
than guessing ambient application context.

## Verbosity and timing

- `summary` (default): one completed run record with aggregate phase durations,
  real progress counts and outcome, plus HTTP host observations when attached.
- `steps`: also retain bounded queue/provider/tool/context spans.
- `progress`: also emit rate-limited, content-free progress records. Default
  interval is one second per run. Transport heartbeats do not count as progress.

Durations use a monotonic clock. Foreground queue duration measures admission
waiting after the consumer reads `run.started`, excluding time paused at that
yield. Detached jobs also include elapsed time from durable acceptance to
execution; that initial wait necessarily uses persisted wall-clock timestamps.
Provider and tool spans cover their asynchronous operations, including provider
retries inside one adapter call. Run duration covers the observed lifecycle;
HTTP duration covers the request handler, including stream backpressure.
Host success describes transport completion: inspect the run outcome for a
failure delivered inside a successful HTTP event stream.

## Bounded delivery

The defaults admit 128 active run observations, retain at most 128 spans per
run, and queue at most 128 records / 2 MB. An in-flight export retains at most
one additional batch of 16 records. Configurable maxima are validated by
`DiagnosticsOptionsSchema`. Reaching these limits drops telemetry and leaves
execution running. `stats` reports drops, active observations, queue bytes,
export failures/timeouts and whether the exporter is disabled. `metrics()`
returns fixed-size local outcome and phase totals for admitted observations,
including unsampled runs; it cannot count observations dropped at admission.

Export happens asynchronously, outside awaited execution. A rejection is not
retried; three consecutive failures disable the exporter. A timed-out exporter
is aborted and disabled immediately, so an implementation that ignores abort
can retain at most one abandoned batch. `exportTimeoutMs` defaults to 1,000 ms
and applies only to telemetry delivery. It never cancels, retries or imposes a
deadline on model/tool work. Run inactivity timeouts remain disabled unless
the application sets one.

Exporters execute on the same JavaScript thread and must not perform blocking
CPU work or synchronous I/O. A promise deadline cannot interrupt a blocked JS
thread. Use a worker or external collector for untrusted/blocking export code.
`flush()` explicitly waits for queued exports; `close()` stops new enqueueing
and drains the existing queue. Neither is awaited by a run. Close after active
work has settled to avoid dropping its final records.

`sampleRate` applies to export, not model execution. Exported OpenTelemetry
metrics represent successfully processed sampled observations and can have
gaps after drops or exporter failures. They are operational signals, not billing
records or authoritative request totals.

## OpenTelemetry bridge

`agenticdriver/opentelemetry` accepts your application's tracer, meter and context
functions. It does not install a global provider, collector or runtime dependency.
Configure the application's OpenTelemetry SDK and network exporters separately.

```ts
import { ROOT_CONTEXT, trace, metrics } from "@opentelemetry/api";
import { Diagnostics } from "agenticdriver/diagnostics";
import { openTelemetryExporter } from "agenticdriver/opentelemetry";

const diagnostics = new Diagnostics({
  level: "steps",
  exporter: openTelemetryExporter({
    tracer: trace.getTracer("my-application"),
    meter: metrics.getMeter("my-application"),
    rootContext: ROOT_CONTEXT,
    withSpanContext: trace.setSpanContext,
  }),
});
```

Completed spans retain their original timestamps. A valid opted-in trace parent
parents the run/host spans; step spans are children of the run. Without one,
use an empty root context as above. IDs and optional names appear only in trace
attributes. The `agenticdriver.operations`, `agenticdriver.duration` (ms) and
`agenticdriver.progress` instruments use only fixed `kind`, `outcome` and `phase`
dimensions. User IDs, run IDs, request IDs and arbitrary names never become
metric labels. Live progress records are for structured exporters; the bridge
exports the final progress aggregate once.

The real OpenTelemetry API and SDK are exercised in offline tests for parent
context, timestamps, metrics and redaction. Refer to the official
[JavaScript instrumentation guide](https://opentelemetry.io/docs/languages/js/instrumentation/)
and [trace API specification](https://opentelemetry.io/docs/specs/otel/trace/api/)
when configuring application tracing.
