# Durable host handoff

Status: planned; original-store serving remains unavailable. No SDK release,
live adoption or inference is part of this planning checkpoint.

An application must be able to extend its existing durable host with a context
resolver while preserving its queue, accepted keys, execution identity, grants
and configured limits. A replacement queue loses the authority of accepted
work. Starting a worker after a separate quietness check can execute work that
arrived between inspection and acquisition.

## Current boundary

[`SqliteJobStore`](../../src/sqlite-job-store.ts) runs retention and expired-lease
recovery before each operation's checks. Even a read can change persisted state.
[`JobStore`](../../src/job-store.ts) fences worker execution, but submission and
cancellation have no worker-ownership argument. A new worker-only acquisition
method therefore cannot, by itself, establish an all-writer handoff.

The downstream read-only preflight correctly always refuses adoption. Its
snapshot is diagnostic evidence, never a lock or permission to serve. Keep
that refusal until the SDK contract and its host integration are qualified.

## Required invariant

A deliberate adoption must atomically compare the expected logical store
snapshot, require a reconciled quiet store, and acquire its single execution
owner. Any refusal must leave **all** persisted job and lease state unchanged,
including expired payloads and accepted-key tombstones. Maintenance must not
run before that decision. Any lease, queued/running work, uncertain outcome or
unrecognized state requires reconciliation; this feature does not add retry or
an automatic reconciliation authority.

The handoff must also exclude stale SDK writers. Submission, cancellation and
maintenance must participate in the same ownership rule as execution writes.
A request which started authorization before handoff must not commit afterward
using obsolete ownership. Keep application authentication and provider account
selection outside this storage contract.

Old binaries and arbitrary same-user SQL writers cannot be made to honor a new
API by adding an advisory marker. Deployment must stop incompatible processes
and establish exclusive operational ownership. Qualify that prerequisite
separately; do not advertise the new SDK API as protection against such writers.

## Slices

1. **Specify the store capability and retained evidence.** Add a versioned,
   optional handoff capability to the existing public store contract. An opaque
   observation binds store identity, logical revision and explicit blockers.
   Acquisition returns one lease-bound mutation handle; avoid optional owner
   arguments scattered across write methods. Every committed relevant change
   invalidates the observation. Persist the ownership generation across release,
   and keep eligibility/uncertainty classification through payload retention.
   Unknown legacy records remain blockers. This slice defines the state table,
   additive custom-store behavior and explicit format-transition policy before
   runtime implementation. The precise TypeScript names/layout are delegated to
   the implementer within those constraints; they are not existing SDK support.
2. **Implement the SQLite transaction and fences.** Use a genuinely read-only
   inspection path that neither initializes nor migrates storage. Conditional
   acquisition compares the observation and checks quietness under the same
   write transaction before maintenance. Refusal rolls back everything. Validate
   the mutation handle's durable generation before any write, including retention
   and recovery. Format provisioning/transition must be explicit and outside
   refused adoption paths; preserve the original queue and accepted keys. Prove
   this slice through private public-store operations without providers.
3. **Integrate the SDK service.** Compose acquisition and mutation authority in
   [`JobService`](../../src/jobs.ts), including requests awaiting authorization,
   reads that maintain storage, cancellation, shutdown and lease loss. Start
   timers, pumping and dispatch only after acquisition succeeds. Keep current
   principal/account/scheduler checks and durable acknowledgements. Ordinary
   supported startup remains explicit; requested adoption never falls back to
   ordinary acquire or a replacement store. Unsupported custom stores refuse
   before serving. Do not invent a reconciliation or retry engine in this pass.
4. **Compose and qualify the owning host.** Consume the supported extension in
   the downstream host. Pin the original config/store identity and exclude old
   processes; retain one queue, existing static subjects, selected execution,
   scheduler and limits. Drain jobs before closing context storage. Then qualify
   a deliberately provisioned real connection and useful application artifact.
   Package release and live deployment remain separately authorized actions.

## Verification

First use real private SQLite stores and public SDK storage operations, with
zero provider execution. Establish queued, cancelled and interrupted states
through those APIs; never fabricate a successful model result. Required cases:

- A changed snapshot or non-quiet store refuses with identical logical rows,
  lease and tombstones, including expired rows which ordinary operations would
  maintain. Competing adoption attempts yield one owner.
- A submission, cancellation, maintenance operation or delayed authorized request
  interleaved across acquisition cannot escape its ownership rule. Verify this
  with separate database handles/processes, not only sequential inspection.
- An obsolete owner cannot write, dispatch or release its replacement's lease.
  Interrupted work is never queued again; retained keys remain deduplicated
  across reopen and expiry.
- Service startup, renewal, shutdown and cancellation use the same store
  contract. Existing custom-store behavior either remains supported explicitly
  or fails before serving; no quiet-adoption fallback is allowed.

Then run focused affected checks and an independent review. Real acceptance
must record current sign-in/catalog, exact account/model/billing path, a useful
public-data prompt, observed artifact and reported usage. Storage tests prove
storage behavior, not provider execution or application acceptance.

## Next agent prompt

Resolve slice 1 against live default `sdk-roadmap` RC.3 store/service code and
its public consumers.
Before writing code, settle how stale writes are fenced and how incompatible
running binaries are excluded. Do not implement only a quiet predicate around
ordinary acquire, alter an original job database, enable the downstream host,
or publish a package from this plan. Keep the existing read-only preflight's
refusal until every required contract is supported and reviewed.

## Plan review

Three independent read-only drafts considered fewest slices, failure risk and
verification seams. All identified the pre-maintenance fencing requirement and
all-writer gap. The combined plan keeps storage verification separate from
service integration and downstream deployment. Durable generations and retained
eligibility are required; adding a general reconciliation engine is deferred.
The public custom-store contract remains the owner, with one mutation handle
for each acquired generation rather than a parallel application job engine.
