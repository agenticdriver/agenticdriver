# Application-owned functions

An application can run its own functions while a local or remote driver handles
the model loop. Functions stay in the application process, in any supported
language. The driver receives a JSON definition, validates model arguments and
requests execution over the run stream. The application returns JSON through a
scoped, single-use execution ticket. No function source, shell command, callback
URL or claimed user identity is accepted in a definition or result.

This works with providers advertising `tools: true`. Native agents' internal
tools are separate; this extension does not add a tool bridge to a provider
whose capabilities declare it unsupported. Applications retain authorization,
canonical data, revision checks and control of external actions.

## Host and application setup

Enable `applicationTools: { enabled: true }` on `AgenticDriver` or in host JSON
configuration. Tools require review by default. For a remote application, add a
token grant for each permitted application function:

```ts
const driver = new AgenticDriver({
  providers: [configuredProvider],
  applicationTools: { enabled: true },
  approvals: { interactive: true },
});
const host = await serve(driver, {
  tokens: [
    {
      token: appToken,
      subject: "application-user-42",
      providers: ["YOUR_INSTANCE"],
      applicationTools: [{ name: "search_passages" }],
      approveTools: ["search_passages"],
    },
  ],
});
```

`applicationTools` grants are separate from `tools`, which grants invocation of
functions already registered on the host. `approveTools` independently permits
review decisions. Only the originating subject, an allowed provider and the
specific application function's grant can submit its progress or result.

For a function approved for automatic execution, the operator must set both
host `applicationTools.requireApproval: false` and that token grant's
`requiresApproval: false`. A definition may still require review. A caller
cannot remove a host or token requirement. The existing host `approve` callback,
if configured, must also allow any call requiring review.

Declare and select the function on each streaming request:

```ts
const request: RunRequest = {
  provider: "YOUR_INSTANCE",
  model: "YOUR_MODEL",
  input: "Find the evidence relevant to this question",
  tools: ["search_passages"],
  applicationTools: [
    {
      name: "search_passages",
      description: "Search sources the current application user may read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { passages: { type: "array", items: { type: "string" } } },
        required: ["passages"],
        additionalProperties: false,
      },
    },
  ],
  approvals: { mode: "interactive", idlePolicy: "pause" },
};
```

`run()` rejects application tools with `TOOL_STREAM_REQUIRED`. Host discovery
advertises `application-tools` only when enabled. Each definition must also
appear in `tools`; duplicate names, unused definitions and collisions with
registered host tools are rejected before model execution. Both schemas use the
[supported synchronous JSON Schema dialects](protocol.md#structured-output-schemas).
All calls in a model response are validated before any of them execute.

## Dispatch, progress and results

Handle interactive approvals as described in [approvals](approvals.md). Execute
only on `tool.execution.requested`; `tool.called` is a proposal and can precede
a denial. The execution event follows any required successful approval and
contains `{ executionId, runId, call: { id, name, arguments } }`.

```ts
for await (const event of client.stream(request, { signal })) {
  if (event.type === "approval.requested") {
    const { approvalId, runId, call } = event.approval;
    const decision = await applicationReview(call);
    await client.decideApproval(
      { approvalId, runId, call, decision },
      { signal },
    );
  }
  if (event.type === "tool.execution.requested") {
    const { executionId, runId, call } = event.execution;
    const identity = { executionId, runId, callId: call.id };
    // This application-owned function enforces the user's source access.
    let output;
    try {
      output = await searchAuthorizedPassages(call.arguments, {
        signal,
        reportProgress: () => client.reportToolProgress(identity, { signal }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      await client.completeTool(
        { ...identity, error: "APPLICATION_TOOL_FAILED" },
        { signal },
      );
      continue;
    }
    await client.completeTool({ ...identity, output }, { signal });
  }
  applicationEvents.accept(event);
}
```

Use an explicit local function map or dispatch by the allowed name when exposing
multiple functions. The clients validate invocation names, run identity and JSON
shape before delivery, and reject repeated execution or call IDs within a run.
They do not execute callbacks automatically. A receipt confirms acceptance of
the supplied result, not success of the model's subsequent response; keep
consuming the stream through its terminal event.

| Binding               | Progress                                           | Result                                                                       |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Embedded TypeScript   | `driver.reportToolProgress(identity, { subject })` | `driver.completeTool(result, { subject })`                                   |
| Remote TypeScript     | `client.reportToolProgress(identity, { signal })`  | `client.completeTool(result, { signal })`                                    |
| Python sync / async   | `report_tool_progress(identity)`                   | `complete_tool(result)` (await both on the async client)                     |
| Go                    | `ReportToolProgress(ctx, execution.Identity())`    | `CompleteTool(ctx, result)`                                                  |
| Rust blocking / async | `report_tool_progress(&execution.identity())`      | `complete_tool(&execution.success(output))` (await both on the async client) |
| HTTP                  | `POST /v1/tool-executions/progress`                | `POST /v1/tool-executions/results`                                           |

Embedded identities are trusted application inputs and default to subject
`local`. Remote identity comes from the host token. A success result adds
`output` (any JSON value); a failure adds only `error: "APPLICATION_TOOL_FAILED"`.
Never forward private exception text. Rust provides `execution.failure()`;
Go uses `json.RawMessage` for output, including `json.RawMessage("null")`.

Progress and result requests bypass the concurrent run-slot limit, so waiting
runs can finish when the host is full. They retain the usual TLS, authentication,
CORS and body-size requirements. The [runnable example](../examples/application-tools.ts)
executes an in-memory lookup over an ephemeral loopback host without credentials
or paid model calls: `npx tsx examples/application-tools.ts`.

## Cancellation, limits and uncertain outcomes

There is no default execution deadline or inactivity timeout. Applications may
set `idleTimeoutMs`; real callback progress resets it. Report progress after
meaningful work, never on a heartbeat timer. Interactive review can pause that
clock according to the explicit approval policy; execution resumes normal idle
accounting. There is no automatic retry of a function or its result submission.

Closing/cancelling the originating run invalidates pending execution tickets.
Pass the application's cancellation signal/context into its own function and
check it before side effects. A callback running in another process cannot be
forcibly undone by the driver. A synchronous callback may not notice a remote
disconnect until it next sends progress/results or resumes reading; cooperative
I/O and cancellation are the application's responsibility.

Pending tickets are process-local and disappear on host restart. Route the run,
review, progress and result requests to the same host process. Stale tickets
produce `TOOL_EXECUTION_NOT_FOUND`; changed run/call bindings produce
`TOOL_EXECUTION_MISMATCH`. Incomplete streams, failed callbacks, cancellation or
invalid output after dispatch can leave effects uncertain. Reconcile application
state before creating any replacement operation. A lost result receipt is also
uncertain until the originating stream or application state confirms the result.
An [idempotent replay](idempotency.md) never re-emits an execution request.

The host accepts at most 32 application definitions per run, with names up to
64 ASCII letters/digits/underscores (starting with a letter or underscore).
Each definition, call and output is bounded to 128,000 UTF-8 JSON bytes. Execution,
run and call IDs have a 256 UTF-16 code-unit bound. Existing model-step, tool-call,
request and stream limits still apply. `maxPending` defaults to 1,000 and rejects
new work with `TOOL_EXECUTOR_CAPACITY`, without evicting existing tickets.

An output-schema or size failure consumes the execution ticket and returns
`INVALID_TOOL_OUTPUT` or `TOOL_OUTPUT_LIMIT` to the result sender. The run reports
an uncertain outcome; submitting an amended result cannot erase an action that
may already have occurred. Malformed, unauthorized or mismatched submissions do
not consume another pending execution.
