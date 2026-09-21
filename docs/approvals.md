# Interactive application tool approvals

The host registers tools and marks actions needing review with
`requiresApproval: true`. Interactive approval requires both host opt-in
(`approvals: { interactive: true }`) and a streaming run that selects the
`interactive-approvals` extension:

```ts
const request: RunRequest = {
  provider: "YOUR_INSTANCE",
  model: "YOUR_MODEL",
  input: "Propose the requested change",
  tools: ["save_proposal"],
  approvals: { mode: "interactive", idlePolicy: "pause" },
};
```

Use `stream()` to receive `approval.requested` and `approval.resolved` events.
`run()` rejects this option with `APPROVAL_STREAM_REQUIRED` before execution.
Applications retain control of presentation, the human's decision and canonical
state. Native CLI agents' internal tool policies are separate; this extension
currently gates registered tools executed by the SDK's application tool loop.

The [runnable embedded example](../examples/approvals.ts) uses only a mock model
and an in-memory proposal list. Run `npx tsx examples/approvals.ts` to review a
proposed action in a terminal.

## Host and token configuration

```ts
const driver = new AgenticDriver({
  providers: [configuredProvider],
  tools: [saveProposalTool], // requiresApproval: true
  approvals: {
    interactive: true,
    allowIdlePause: true,
    maxPending: 1000,
    onAudit(record) {
      applicationAudit.appendSynchronously(record);
    },
  },
});
const host = await serve(driver, {
  tokens: [
    {
      token: driverToken,
      subject: "application-user-42",
      providers: ["YOUR_INSTANCE"],
      tools: ["save_proposal"],
      approveTools: ["save_proposal"],
    },
  ],
});
```

`tools` allows invocation; `approveTools` independently grants decisions. A
decision token must have the same authenticated subject as the originating run,
the run's provider grant and the exact tool's approval grant. It may be a separate
review credential for that subject. Request bodies cannot supply a subject or
grants. Normal TLS, bearer authentication, CORS and request-size rules apply.
Decision requests do not consume run slots: a full host can still resolve its
waiting runs. They are single-use and are never automatically retried.

Host JSON configuration accepts `approvals` with `interactive`, `allowIdlePause`
and `maxPending`, plus `approveTools` on each token. Embedders using
`configuredDriver` can provide `onApprovalAudit`. CLI configuration alone does
not install application tools. Hosts without this opt-in preserve the existing
approval callback behavior. If an `approve(call, context)` callback is also
configured, it must allow the call **before** interactive review; the application
decision cannot override a host denial.

## Events and decisions

`approval.requested.approval` contains `approvalId`, `runId`, `call` (including
the tool call ID, name and JSON arguments), `requestedAt`, `idlePolicy`, and an
optional `expiresAt`. It follows `tool.called`, which means the model proposed a
call, not that execution has started.

Copy the reviewed identifiers and call into the decision:

```ts
for await (const event of client.stream(request)) {
  if (event.type === "approval.requested") {
    const { approvalId, runId, call } = event.approval;
    const decision = await applicationReview(call); // "approve", "deny", or "cancel"
    await client.decideApproval({ approvalId, runId, call, decision });
  }
  applicationEvents.accept(event);
}
```

Embedded applications call `driver.decideApproval(decision, { subject })` with
their trusted application identity (default `local`). Remote applications use
`POST /v1/approvals/decisions`. Decisions bind to the stored snapshot, including
array order and every argument value; JSON object key order is immaterial.
Changing arguments requires a new proposal and review. Repeating a decision or
using an ended run's request fails with `APPROVAL_NOT_FOUND`. A different subject
gets the same response without revealing whether an approval exists.

The execution host limits a proposed call to 128,000 UTF-8 JSON bytes so its
decision also fits the request bound with clients that escape HTML or Unicode.
Arguments that schema validation cannot preserve exactly are rejected before
review; validation never silently changes the executable action.

`approval.resolved.resolution` and the decision receipt contain `approvalId`,
`runId`, `callId`, `outcome` and `decidedAt`. A receipt acknowledges the decision;
only the subsequent tool and run events establish execution outcomes. If a
decision response is lost, observe the original stream and reconcile application
state. An acknowledged approval does not guarantee that execution occurred.

| Decision or event                               | Resolution                | Run behavior                                                                                         |
| ----------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `approve`                                       | `approved`                | Recheck cancellation, then invoke the exact reviewed action once.                                    |
| `deny`                                          | `denied`                  | `run.failed` / `APPROVAL_DENIED`; this tool is not executed.                                         |
| `cancel`                                        | `cancelled`               | `run.cancelled` / `CANCELLED`; this tool is not executed.                                            |
| Application approval expiry                     | `expired`                 | `run.failed` / `APPROVAL_EXPIRED`; this tool is not executed.                                        |
| Run abort, disconnect, stream close or shutdown | `cancelled` while pending | Invalidate the approval and release its resources. A closed transport cannot deliver further events. |

Already completed actions in earlier steps are not rolled back. After execution
starts, existing cancellation and uncertain-outcome rules apply. Tools must
still reauthorize current application state and check expected revisions when
committing a change; approval does not freeze an email, document or proposal.
Concurrent run cancellation takes precedence over a terminal failure; the audit
record retains the review outcome.

## Human wait and inactivity

There is **no default approval expiry, run deadline or inactivity timeout**.
Each interactive request explicitly chooses `idlePolicy`:

- `pause` suspends the configured activity clock while the person decides. The
  full inactivity interval resumes when the decision settles, even if a local
  consumer stops reading events. Host `allowIdlePause: false` rejects this choice.
- `continue` leaves any configured `idleTimeoutMs` running. With no configured
  inactivity timeout, this choice still imposes no deadline.

Applications can set `approvals.expiresAfterMs` to a positive integer up to
2,147,483,647. It bounds each human review, starting when its approval is created;
it is independent of model/tool activity and any inactivity pause. Expired
decisions are rejected even if the timer callback has not yet run. Heartbeats
do not count as progress. Awaiting approval occupies the existing run slot.

## Audit, replay and compatibility

The private `onAudit` callback receives requested/resolved records with the
subject, provider and reviewed snapshot, plus rejected decision identities and
codes. Supply a synchronous sink; a throw or accidentally async sink fails
closed with `APPROVAL_AUDIT_FAILED`. Raw sink exceptions are not sent to clients.
Copies isolate audit/UI mutations from the executable action. Store these records
under the application's access and retention policy; arguments may contain its
private data. No audit database or UI is imposed by the SDK.

Configured operation stores retain the approval events in the accepted run's
compact log. Outcome replay omits these historical approval events so it cannot
prompt a second review. Pending permissions are process-local and are not
restored after restart; accepted operations retain their existing uncertainty
barrier. Durable jobs and resume are separate features.
Route decisions to the execution process owning the originating stream; a
replica without that pending request cannot authorize it.

Hosts advertise `interactive-approvals` only when enabled. New events are required
and emitted only for a request explicitly selecting this feature. They cannot be
skipped as optional advice. Old request shapes retain their original behavior;
older hosts reject the new request field instead of silently ignoring approval.

| Client                  | Request / decision API                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / JavaScript | `approvals`, `decideApproval(decision, { signal })`                                                                              |
| Python sync / async     | `ApprovalPolicy`, `decide_approval(decision)`; await on the async client                                                         |
| Go                      | `Request.Approvals`, `DecideApproval(ctx, decision)`                                                                             |
| Rust blocking / async   | `RunRequest.approvals`, `ApprovalPolicy::interactive(...)`, `approval.decision(ApprovalAction::Approve)`, `decide_approval(...)` |

Client decision requests add no default deadline. Application cancellation and
explicit transport timeouts remain available. The wire schemas are in
[OpenAPI](../protocol/openapi.json); shared fixtures exercise malformed approval
payloads, unnegotiated events and mismatched receipts in every client.
