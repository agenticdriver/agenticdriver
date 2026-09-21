# Detached jobs

Durable jobs are opt-in. They keep an accepted run alive when its submitting
client disconnects and let authorized clients inspect status, cancel it, or read
committed events after an ordered cursor. The ordinary `run`/`stream` APIs keep
their existing cancellation-on-disconnect behavior.

Applications still own review stages, inbox checkpoints, canonical documents,
tool transactions, proposal acceptance and reconciliation. A job is one bounded
SDK model/tool loop, not an application workflow engine. Usage goes through the
existing per-run Usagestat integration; polling and replay do not generate new
usage records or provider calls.

## Enable storage and permissions

The built-in store uses a dedicated SQLite database in a private, host-owned
directory and requires Node 22.13+. It commits before acknowledging submission
or advancing execution past an event. It does not install a database service.

```ts
import { AgenticDriver, SqliteJobStore } from "@agenticdriver/sdk";
import { serve } from "@agenticdriver/sdk/server";
import { mockProvider } from "@agenticdriver/sdk/providers";

const store = await SqliteJobStore.open("/private/driver/jobs.sqlite", {
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxJobs: 1000,
  maxJobsPerSubject: 100,
  maxBytes: 64_000_000,
  maxJobBytes: 8_000_000,
});
const driver = new AgenticDriver({
  providers: [mockProvider()],
  usage: { hostId: "review-host", accounts: { mock: "synthetic-account" } },
});
const host = await serve(driver, {
  port: 7433,
  tokens: [
    {
      token: process.env.DRIVER_TOKEN!,
      subject: "review-service",
      providers: ["mock"],
      jobs: ["submit", "read", "cancel"],
    },
  ],
  jobs: { store, leaseMs: 30_000, pollIntervalMs: 250, maxWorkers: 32 },
});
// On shutdown: await host.close(); await store.close();
```

`retentionMs` is required. Database storage, job permissions and account bindings
are never silently enabled. Each provider used by a job needs a persistent
`usage.hostId` and an explicit `accountId`. TLS remains required outside loopback.
Token job grants are separate from provider/tool/corpus grants; all applicable
grants must allow the operation. Knowing a job UUID does not grant access.

The CLI host accepts the equivalent `jobs` configuration:

```json
{
  "jobs": {
    "path": "private/jobs.sqlite",
    "retentionMs": 604800000,
    "maxJobs": 1000,
    "maxJobsPerSubject": 100,
    "worker": { "leaseMs": 30000, "pollIntervalMs": 250, "maxWorkers": 32 }
  }
}
```

Add `jobs: ["submit", "read", "cancel"]` to the appropriate existing token
entries and `accountId` to the selected provider. Paths resolve relative to the
config file. `doctor` validates configuration without opening the database;
`serve` opens and closes the configured store. A store supplied directly to
`serve` stays caller-owned; a store factory is opened and closed by the host.

## Submit, inspect and reconnect

```ts
const job = await client.submitJob({
  key: "review-42-extraction-v3",
  request: {
    provider: "mock",
    model: "demo",
    input: "Summarize selected evidence",
  },
});
const status = await client.readJob({ id: job.id });
const page = await client.jobEvents({ id: job.id, after: 0, limit: 100 });
// Persist page.nextCursor alongside the application's accepted checkpoint.
// Reconnect with that cursor; keep polling while the job is queued/running.
// Cancellation is an explicit operation:
await client.cancelJob({ id: job.id });
```

| Binding             | Submit       | Inspect    | Cancel       | Event page   |
| ------------------- | ------------ | ---------- | ------------ | ------------ |
| TypeScript          | `submitJob`  | `readJob`  | `cancelJob`  | `jobEvents`  |
| Python sync/async   | `submit_job` | `read_job` | `cancel_job` | `job_events` |
| Go                  | `SubmitJob`  | `ReadJob`  | `CancelJob`  | `JobEvents`  |
| Rust blocking/async | `submit_job` | `read_job` | `cancel_job` | `job_events` |

All four endpoints use POST JSON: `/v1/jobs/submit`, `/read`, `/cancel`, `/events`.
The host advertises `durable-jobs` in authenticated protocol discovery. Submission
requires `{key, request}`; read/cancel use `{id}`; events use `{id, after, limit?}`.
The cursor starts at zero and refers to the last consumed event sequence.
Pages contain `{job, events, nextCursor, hasMore}`. `hasMore` means more events
are currently committed, not that execution has ended. Read `job.state` too.
An empty page at the current cursor is valid. A cursor ahead of the log fails.

Pages contain at most 100 events and approximately 1.5 MB of event JSON. Each event
is bounded to 1,500,000 UTF-8 JSON bytes, below the clients' 2 MB response limit.
Large outputs or a full log interrupt the job with an uncertainty barrier. Clients
validate contiguous sequences, run/job identities, metadata and terminal states.
Event pages are observations: they never automatically dispatch application tools.

Submission keys are scoped by authenticated subject. Reusing a key with the same
request returns its original job; a different request fails `IDEMPOTENCY_CONFLICT`.
If a submission response is lost, submit the same key and request to discover
the accepted job. Neither a client timeout nor an aborted submission response
proves the job was not accepted. Job keys and foreground `idempotencyKey` records
are separate namespaces; nested `request.idempotencyKey` is rejected.

## Recovery and effects

| State                              | Recovery behavior                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `queued`                           | May start after current permissions, configuration, account binding and admission are checked.                                  |
| `running`                          | Its current worker owns execution. Cancellation requests abort it; effects already committed remain.                            |
| `completed`, `failed`, `cancelled` | Recorded outcome is replayable while retained; the job is never executed again.                                                 |
| `interrupted`                      | Execution ownership or event persistence ended after starting. Reconcile effects in the application; no automatic continuation. |

A `tool.called` event is committed before requesting the generator's next event,
which permits tool execution. It establishes an uncertainty boundary, not proof
that an effect happened. A committed `tool.completed` records the returned result.
The crash window between an external effect and saving its result cannot be made
atomic by this SDK. Tools must enforce their own idempotency/transaction semantics
and observe cancellation. JavaScript callbacks can continue if they ignore their
abort signal. This is not an exactly-once external-effect guarantee.

The default SQLite implementation has one renewable worker owner per database,
with atomic fencing across processes. A second live owner gets `JOB_WORKER_BUSY`.
After a crash it can acquire ownership when the lease expires. It marks previously
running jobs interrupted and leaves queued jobs available. The old owner cannot
renew or append results once fenced. Clean shutdown records the same interruption
barrier immediately. Use a local filesystem suitable for SQLite locking, not a
shared network filesystem or a replicated multi-host database file.

The HTTP host persists a digest identifying the submitting credential, never its
bearer value. Dispatch after restart requires that credential still be configured
with its original subject and sufficient grants. Credential rotation/revocation,
scope removal or a changed provider account fails queued work before inference;
it does not silently transfer work to another account. Any current token for the
same subject with sufficient read/cancel and resource grants can inspect/cancel
the old job. Host tool code must enforce current application authorization when
accessing canonical data.

The first job contract supports stateless history, host-registered tools and
host approval callbacks. It rejects process-local conversation sessions,
interactive approval tickets and application executor tickets. Use foreground
runs for those interactions and keep durable application checkpoints outside
the driver. Do not turn historical invocation events into fresh tool calls.

RAG and authorized references are accepted and resolved at execution time.
Evidence-bearing events are exposed only after successful completion provides
a full snapshot to reauthorize. Every subsequent event read rechecks source
access/revisions without regenerating or re-embedding. Running/interrupted
evidence jobs return `CONTEXT_REPLAY_UNAVAILABLE` from event reads; their status
and cancellation remain available. Inline context belongs to the submitting
application; the SDK has no external permission resolver for inline copies.

## Retention, leases and scheduling

No default job deadline or inactivity timeout exists. An explicit
`request.idleTimeoutMs` measures model/tool/context inactivity only after dispatch.
Queue waiting, polling and lease renewal do not reset it. `leaseMs` measures
worker ownership and crash detection, not run duration; normal renewal can
continue for an arbitrarily long job. Heartbeats never fabricate model progress.

`retentionMs` begins when the job becomes terminal. Maintenance on store operations
and worker heartbeats removes expired requests/events, including tool inputs,
outputs and generated text. Reads then return `JOB_EXPIRED`. A small tombstone
retains job ID, subject, key hash, request fingerprint, state and expiry to prevent
reusing an accepted key. Tombstones count toward `maxJobs` and per-subject capacity;
the store fails `JOB_STORE_FULL` rather than silently dropping accepted keys.
An operator can archive/replace a full store only after applications reconcile
its keys and accept that deduplication does not cross independent databases.
Retention is logical removal; operators own database backups and file lifecycle.

The worker shares the host's [scheduler and resource policies](scheduling.md)
with foreground runs. Dispatch rotates subjects and candidates, skips busy caps,
and leaves waiting jobs in durable storage. It does not consume a second
in-memory waiting queue. `maxWorkers` bounds concurrent dispatch attempts/runs;
host/subject/account caps may lower execution concurrency. This is a single-host
queue; installation-wide distributed scheduling is an external responsibility.

For embedding, `JobService.open(driver, {store, resolvePrincipal, ...worker})`
requires a resolver for current trusted permissions. `JobStore` is a public
interface for custom stores. Implementations must atomically claim accepted
keys, fence expired/released workers, persist before acknowledgement, retain
tombstones, and never return started work to the queue. The built-in store tests
exercise these boundaries. Run the installed package example
[`examples/javascript/jobs.mts`](../examples/javascript/jobs.mts) for a synthetic
submission, replay and store reopen without vendor credentials.
