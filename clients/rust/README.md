# AgenticDriver Rust client

Typed clients for an authenticated AgenticDriver host: discovery, buffered runs,
event streaming, scoped retrieval, ingestion and vector indexing/deletion.
Requires Rust **1.89+** and, for the async interface, a Tokio runtime with I/O and
time enabled. Canonical data, authorization and acceptance of draft artifacts stay
with the application.

Optional [detached jobs](../../docs/jobs.md) expose `submit_job`, `read_job`,
`cancel_job` and `job_events` in both blocking and async clients, with public
`JobSubmit`, `JobInfo`, `JobState`, `JobIdentity`, `JobEventsRequest` and
`JobEventPage` types. Dropping an HTTP future does not cancel accepted background
work; use `cancel_job` explicitly. Reconnect using `next_cursor`; event pages
never execute application tools.

The crate is currently built from this repository; it is not published on
crates.io. From an application beside a checkout:

```toml
[dependencies]
agenticdriver = { path = "../agenticdriver/clients/rust", default-features = false, features = ["async"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

| Features                     | Interface                                                               |
| ---------------------------- | ----------------------------------------------------------------------- |
| Default: `async`, `blocking` | Both client styles                                                      |
| `async` only                 | `AsyncAgenticClient`, `EventStream`                                     |
| `blocking` only              | `AgenticClient` (also `blocking::AgenticClient`)                        |
| No default features          | Shared request, response, event and error types; no client constructors |

Both transports use Rustls with certificate and hostname verification. Remote
hosts require HTTPS; HTTP is allowed only for loopback. Redirects and automatic
transport retries are disabled. A bearer token and an explicit provider/model
selection are required. No provider fallback is performed.

## Async

```rust,no_run
# #[cfg(feature = "async")]
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
use agenticdriver::{AsyncAgenticClient, EventPayload, RunRequest};

let client = AsyncAgenticClient::new(
    "https://driver.example", std::env::var("DRIVER_TOKEN")?,
)?;
let request = RunRequest::new("my-provider-instance", "my-model", "Summarize this context");
let mut stream = client.stream(&request).await?;
while let Some(event) = stream.next().await {
    let event = event?;
    match event.payload()? {
        EventPayload::TextDelta { text } => print!("{text}"),
        EventPayload::RunCompleted { result } => println!("\nRun: {}", result.run_id),
        EventPayload::RunFailed { error } | EventPayload::RunCancelled { error } => {
            return Err(agenticdriver::Error::Driver(error.clone()).into());
        }
        _ => {}
    }
}
# Ok(())
# }
```

`run`, `protocol`, `providers`, `refresh_providers`, `ingest_context`,
`index_context`, `search_context`, and `delete_context` are async methods. `run`
returns `RunResult` or an `Error`, including `Error::Driver(DriverError)` with an
open-ended code, message, retryable flag and optional uncertain outcome.

`stream().await` returns an owned stream with `next().await -> Option<Result<Event>>`.
`Event::payload()` provides a typed `EventPayload` enum for exhaustive handling
with a wildcard for future additions. Envelope fields and the existing `extra`
map remain available. A `run.failed` or `run.cancelled` **event is returned once**;
the caller handles its typed error. Wire/transport errors return `Err` once.
After any terminal event or error, `next()` returns `None` and the response is closed.

Dropping the stream or calling `close()` closes the HTTP response, which signals
cancellation to the host. Dropping an in-flight `run`, `stream`, ingestion or
retrieval future also closes that request. A polled `next()` future owns its
response: cancelling it (for example, the losing branch in `tokio::select!`)
**closes the entire stream**. Subsequent reads return `None`; this is not a
resumable read timeout. An unpolled future has no effect. There is no background
reader or per-stream worker thread. Reads apply backpressure, and independent
streams may share a cloned client. Dropping a client does not close streams that
have already been returned; the stream owns that responsibility.

## Blocking

```rust,no_run
# #[cfg(feature = "blocking")]
# fn example() -> Result<(), Box<dyn std::error::Error>> {
use agenticdriver::{AgenticClient, RunRequest};
let client = AgenticClient::new("http://127.0.0.1:7433", std::env::var("DRIVER_TOKEN")?)?;
let request = RunRequest::new("my-provider-instance", "my-model", "Hello");
let result = client.run(&request)?;
client.stream(&request, |event| {
    if let Some(text) = event.text { print!("{text}"); }
    true // Returning false cancels and closes the unfinished response.
})?;
# Ok(())
# }
```

Create, use and drop the blocking client outside an async runtime, or entirely
inside `tokio::task::spawn_blocking`. The existing callback API is preserved: it
visits failure/cancellation terminal events and then returns `Error::Driver`
unless the callback returns `false`. A callback cannot interrupt a pending
blocking network read; use the async interface for prompt external cancellation.

## Timeouts and private CAs

Runs and context operations have **no default total or read timeout**. Optional
`RunRequest::idle_timeout_ms` / `IngestRequest::idle_timeout_ms` is measured by the
host against actual model/tool/context progress; protocol pings do not reset it.
Omitting it adds no inactivity policy. The transport bounds connection setup to
10 seconds and discovery requests to 10 seconds; these are separate from run time.

For a private CA, call either client's `with_ca_pem(url, token, Some(&pem_bytes))`.
This adds a trusted CA and preserves certificate and hostname checks. Never send
provider API keys as driver bearer tokens. Keep the driver token in server-side
configuration or the application's credential store.

`npm run test:rust` builds a `.crate`, verifies its contents, installs the extracted
archive into a separate application, checks every feature combination on Rust
1.89, and exercises both clients over HTTP and verified HTTPS. It also runs
shared wire/version fixtures, cancellation/disconnection checks, scoped RAG and
ingestion round trips. It does not publish to a registry or call a live model.

## Interactive approvals

Set `request.approvals = Some(ApprovalPolicy::interactive(ApprovalIdlePolicy::Pause))` and consume a stream. Match `EventPayload::ApprovalRequested { approval }`, review its call, then use `client.decide_approval(&approval.decision(ApprovalAction::Approve))` (await on the async client). `Deny` and `Cancel` are also explicit actions. Match `ApprovalResolved` for the outcome; keep consuming to the terminal run event.

The host must enable this feature and grant `approveTools`. `run` rejects
interactive mode because it cannot deliver review requests. There is no default
approval expiry; choose `expiresAfterMs` / the typed equivalent when needed.
Decisions are single-use and are never retried automatically. A receipt does not
confirm a tool effect. See the [approval contract](https://github.com/agenticdriver/agenticdriver/blob/sdk-roadmap/docs/approvals.md).

## Functions in your application

Set `RunRequest.application_tools` to `Vec<ApplicationToolDefinition>` and select
the same names in `tools`. Match `EventPayload::ToolExecutionRequested { execution }`
to invoke your application's function. Use
`client.report_tool_progress(&execution.identity())` after real work and
`client.complete_tool(&execution.success(output))` to return a `serde_json::Value`
once. Await both on the async client. `execution.failure()` sends the fixed public
failure code without leaking private exception details.

Host opt-in and named token grants are required; review defaults to required.
Dropping/cancelling the stream invalidates tickets. The application must also
cancel its own work cooperatively; effects cannot be undone by a disconnect.
There is no default inactivity deadline or automatic retry. See the
[full contract](https://github.com/agenticdriver/agenticdriver/blob/sdk-roadmap/docs/application-tools.md).

## Conversation sessions

Create/read/delete methods and typed session models support explicit conversation
continuation. Pass only the returned session ID and revision on each run, then
use the next revision from the successful result. Provider/account/model changes
require an explicitly created conversation with exported visible history.
Host opt-in, account binding and per-operation token grants are required. Idle
retention pauses during active work; no default execution deadline is introduced.
See the [session contract and binding examples](https://github.com/agenticdriver/agenticdriver/blob/sdk-roadmap/docs/sessions.md).
