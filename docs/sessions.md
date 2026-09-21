# Explicit conversation sessions

Sessions let an application continue a conversation across runs without sending
its full history each time. Storage is opt-in, process-local and bounded. Each
session belongs to an authenticated subject, provider instance, account binding
and model. Ordinary runs remain stateless unless they select a session.

The host must choose an idle retention period and give the provider a stable,
opaque account ID using the existing usage identity configuration:

```ts
const driver = new AgenticDriver({
  providers: [provider],
  usage: { hostId: "personal-driver", accounts: { personal: "account-one" } },
  sessions: { retentionMs: 86_400_000 },
});
const host = await serve(driver, {
  tokens: [
    {
      token: appToken,
      subject: "application-user-42",
      providers: ["personal"],
      sessions: ["create", "read", "continue", "delete"],
    },
  ],
});
```

Use the configured provider instance's actual ID in `accounts`. Host JSON accepts
the same `sessions` policy; its provider's `accountId` supplies the account binding.
Update that binding whenever an instance switches accounts. The SDK does not
infer an account from a secret, model name or CLI login. An unbound instance can
still run stateless requests; session creation returns `SESSION_ACCOUNT_REQUIRED`.

## Continue and delete

```ts
const created = await client.createSession({
  provider: "personal",
  model: "YOUR_MODEL",
  mode: "history",
  instructions: "Help the user explore this topic",
});
const first = await client.run({
  provider: "personal",
  model: "YOUR_MODEL",
  input: "Propose three directions",
  session: { id: created.session.id, revision: created.session.revision },
});
const second = await client.run({
  provider: "personal",
  model: "YOUR_MODEL",
  input: "Develop the second direction",
  session: { id: first.session!.id, revision: first.session!.revision },
});
await client.deleteSession({ id: second.session!.id });
```

Copy only `id` and `revision` into a run's session handle. Successful results
return session metadata with the next revision. Only one turn may run in a
session at a time. A stale revision returns `SESSION_REVISION_CONFLICT`; an active
turn returns `SESSION_BUSY`. Neither starts another model call. Streaming runs,
interactive approvals and application-owned functions use the same contract.

`readSession({ id })` returns metadata, instructions and portable visible history.
It can reconcile a lost final response; it does not extend retention. Creation
may import a bounded `history` of `{ role: "user" | "assistant", content }`
messages. History and instructions belong to the session after creation, so a
run cannot override them. No endpoint accepts native state from a client.

| Binding                              | Create                      | Read/export                  | Delete                         |
| ------------------------------------ | --------------------------- | ---------------------------- | ------------------------------ |
| TypeScript client or embedded driver | `createSession(input)`      | `readSession({ id })`        | `deleteSession({ id })`        |
| Python sync / async                  | `create_session(input)`     | `read_session({"id": id})`   | `delete_session({"id": id})`   |
| Go                                   | `CreateSession(ctx, input)` | `ReadSession(ctx, identity)` | `DeleteSession(ctx, identity)` |
| Rust blocking / async                | `create_session(&input)`    | `read_session(&identity)`    | `delete_session(&identity)`    |
| HTTP POST                            | `/v1/sessions/create`       | `/v1/sessions/read`          | `/v1/sessions/delete`          |

Await Python/Rust async methods. In Go, use `SessionInfo.SessionHandle`; in Rust,
use `SessionInfo.handle` and `.identity()`. Embedded TypeScript methods accept a
trusted `SessionPrincipal` as their second argument, defaulting to subject `local`.
Remote clients cannot supply subject, account or permissions. Each operation has
its own token grant and also checks the provider grant. Deletion can cancel a
waiting run even when all concurrent run slots are occupied.

## Visible history and provider state

Choose a mode explicitly:

- `history` retains the submitted user text and final visible assistant text.
  It omits tool exchanges and private provider data from subsequent runs.
- `native` also retains the provider's JSON state and completed tool exchanges
  inside the host, preserving signed/encrypted blocks needed for continuation.
  The public history export still contains only visible user/assistant messages.

Discovery advertises `historyContinuation` and `nativeContinuation` separately.
The OpenAI Responses, Anthropic and Gemini API adapters implement native state
replay through their existing message contracts. Fixtures verify preservation
and non-disclosure; live model/account certification remains separate. Current
CLI adapters and OpenAI-compatible/xAI adapters advertise only history mode;
they do not silently resume a native CLI session or switch billing modes.
Unsupported modes return `UNSUPPORTED_CONTINUATION`.

A stored session cannot change provider, account or model. To switch explicitly,
read its visible history, select what the new model should receive, and create a
new session with that history. Opaque state is never portable. This may lose
provider-specific context and tool exchange detail; no automatic conversion or
fallback takes place.

Stored sessions currently accept text and application tools. Combining a session
with `attachments` or `retrieval` returns `SESSION_CONTEXT_UNSUPPORTED`, before
model execution. For grounded conversations, applications can continue using
the existing `history` field with freshly authorized context/retrieval on each
stateless run. This keeps canonical revisions and source permissions in the
application. A history export is conversation text, not source provenance.

## Retention, bounds and recovery

`retentionMs` is required when enabling storage. It counts idle time after
creation or the last finished/interrupted turn. Retention is suspended throughout
an active run, including approval and tool waits. It never creates a total run
deadline; `idleTimeoutMs` remains separately opt-in and progress-based. Idle
records expire automatically through unreferenced timers, with access-time
checks as well. Session timestamps use UTC with millisecond precision.

Defaults are 1,000 records, 100 visible messages and 1,000,000 bytes per record.
`maxEntries`, `maxMessages` and `maxRecordBytes` can tighten these limits. The
encoded history, provider messages and instructions count towards the byte
bound; native exchanges also have a 2,048-message limit. No truncation or
summarization happens implicitly. Full storage rejects new sessions; a context
limit rejects growth. Applications choose any smaller history explicitly.

Cancellation, disconnect or failure after model work starts marks a session
`interrupted`. Its last successful visible history remains available, but another
turn is refused with `SESSION_INTERRUPTED`. Reconcile application/tool effects
before creating a replacement conversation. If work never started, the session
returns to `ready`. SDK idempotency can replay an accepted outcome without
advancing the revision; replay still checks current session access and cannot
recreate deleted state.

Deletion removes the session and aborts its active turn. It cannot undo external
tool effects, copies already held by an application, or independently configured
operation logs/provider retention. Session storage stays in memory and is created
only on request. Host restart loses all its sessions. Route related
requests to the same host process; durable jobs/storage are separate features.
