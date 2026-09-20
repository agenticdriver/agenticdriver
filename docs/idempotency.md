# Idempotency, recovery and safe retries

An idempotency key identifies one accepted operation for one authenticated
subject. Reusing the same key and request returns the saved outcome without
calling the provider or tools again. Reusing it with a different request produces
`IDEMPOTENCY_CONFLICT`. Object-key order is ignored; changed values, arrays,
metadata, model, provider or retry settings are different requests.

## Configure storage on the execution host

The host must explicitly configure an operation store before accepting keys.
Hosts without one reject keyed requests with `IDEMPOTENCY_UNAVAILABLE` and do not
start a model call. Configured hosts advertise `idempotency` in `/v1/protocol`.

```ts
import { AgenticDriver, FileOperationStore } from "agenticdriver";

const driver = new AgenticDriver({
  providers,
  tools,
  operations: new FileOperationStore("/absolute/private/path/operations"),
});
```

`FileOperationStore` retains accepted keys and compact recovery records across
host process restarts. It uses exclusive hard-link claims and atomic replacement
of files on the same local filesystem, flushes file data before acknowledging a
write, and flushes directory entries on POSIX systems. Concurrent processes using
the same directory cannot claim the same subject/key twice. An unfinished record
owned by another process is reported as uncertain; it is never taken over or
restarted automatically.

Use a private host-owned directory. Newly created directories use mode 0700 and
files use 0600 on POSIX systems. Existing directories with group/other access are
rejected. On Windows, the host must provision appropriate directory ACLs; this
API does not provide POSIX directory-flush guarantees. Shared network filesystems,
disk/controller failures and distributed databases need a separately validated
store implementation; the included crash test verifies process termination and
restart on a local filesystem.

`MemoryOperationStore` provides the same claim behavior within that store object's
lifetime. Its default limit is 1000 accepted keys. It is useful for embedded or
test applications that do not need restart recovery. Never replace it with a fresh
instance and assume previous keys remain protected.

Both stores default to an 8 MB limit per recovery record, configurable with
`maxRecordBytes`. The memory store also accepts `maxEntries`. Limits reject new
work or mark an existing operation uncertain; accepted keys are never silently
evicted. Existing file outcomes can be read without creating another claim file.
Keep the store and its backups for the required deduplication lifetime. Deleting
records, changing directories or switching stores removes protection for those
keys; this release deliberately exposes no automatic expiry or deletion API.

## Submit and replay

```ts
const request = {
  provider: "openai-work",
  model: "explicit-model-id",
  input: "Review the supplied material",
  idempotencyKey: "review-123-stage-2",
};
const first = await client.run(request);
const replay = await client.run(request); // same runId and result
```

Python accepts `idempotencyKey` in `client.run`/`stream` keyword arguments. Go uses
`Request.IdempotencyKey`; Rust uses `RunRequest.idempotency_key`. The key is part
of the request body and must contain 1–128 ASCII letters, digits, dots,
underscores, colons or hyphens, starting with a letter or digit. Credentials stay
in host configuration and are never placed in the key.

Claims are scoped by authenticated subject, so two tokens for the same subject
share protection, while different subjects have independent keys. Current
provider/tool authorization and request validation still apply to replays.
Unkeyed requests retain their existing execution behavior. Clients do not
automatically resubmit a disconnected request or generate a replacement key.

During execution on the same driver, a duplicate request returns
`OPERATION_IN_PROGRESS`. Retry that same key later to obtain its outcome. A stored
failure or cancellation is replayed as that same failure or cancellation. It is
not treated as permission to start the operation again after changing credentials
or waiting for quota.

## Recover tool outcomes

Acceptance is committed before model execution. A tool-call record is committed
before the tool can execute, and confirmed tool output is committed before being
sent to the client. A final result is committed before a successful response.
Usage callbacks run for the original execution only, not on replay.

The compact log retains run/step boundaries, tool calls, tool outputs, usage
events and the terminal outcome. It excludes streaming text and progress deltas;
the completed result retains its final text. Streaming the same request/key
replays that log with contiguous sequence numbers and the original run ID. This
is recovery of recorded outcomes, not full token-stream replay or resumed model
execution. Durable jobs and full event replay are separate roadmap items.

If a process stops or storage fails before a terminal outcome is recorded,
replay returns the known tool records followed by `OPERATION_UNCERTAIN`. A
`tool.called` record alone does not prove whether the tool executed. A
`tool.completed` record confirms the output the application supplied. Reconcile
unconfirmed effects with the application's own transaction/audit records before
creating any replacement operation. The SDK does not blindly replay tools.

Errors can include `outcome: "uncertain"`. An invoked tool that fails before its
output is confirmed produces `TOOL_OUTCOME_UNCERTAIN`. Cancellation or inactivity
keeps the familiar `CANCELLED` or `IDLE_TIMEOUT` code and adds the uncertainty flag.
All four clients retain it. Such failures are not marked retryable. This does not
make external effects atomic with local storage: a tool can succeed and the
process can stop before its result is saved. Applications still own recovery of
that external effect.

## Opt-in provider retries

```ts
await client.run({
  ...request,
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
});
```

The default is one attempt. An explicit policy allows at most five attempts per
model step. The host can lower the limit with `limits.maxAttempts`. Go exposes
`RetryPolicy`; Rust exposes `RetryPolicy`; Python accepts the corresponding
`retry` dictionary. Adapters advertise `safeRetries`; unsupported adapters reject
policies with more than one attempt before execution. Native CLI adapters do not
advertise or perform automatic retries.

The included API transport retries only an HTTP 429 rejection received before
streaming begins. It keeps the same URL, body, model and resolved credential
throughout those attempts. Network errors, HTTP 5xx responses, authentication
errors and partial streams have potentially indeterminate outcomes and are never
automatically replayed. A rejected follow-up model request may be retried without
re-executing the tools whose outputs are already in that request.

Backoff doubles from `baseDelayMs` (default 500). `Retry-After` seconds or HTTP dates
set a minimum wait. Invalid hints or a wait exceeding `maxDelayMs` (default 30
seconds, maximum 60 seconds) stop retries; the SDK never shortens a vendor hint to
fit the local bound. Cancellation interrupts the wait. Waiting is not real model
or tool progress and therefore does not reset an enabled inactivity timeout.
Neither idempotency nor retries introduces a total run deadline or enables the
inactivity timeout by default.

The HTTP rate-limit semantics follow [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585#section-4).
Provider documentation describes [OpenAI rate-limit failures](https://developers.openai.com/api/docs/guides/error-codes)
and [Anthropic retry hints](https://platform.claude.com/docs/en/api/rate-limits).
Other provider/endpoint failures are not inferred to be safe merely because an
error has `retryable: true`.
