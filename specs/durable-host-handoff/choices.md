# Choices

## Sound — high confidence: handoff belongs to the existing SDK store owner

**When:** original-host preflight integration review.

**Choice:** If an operator adds a resolver to an existing host, the SDK must
check the original queue and obtain ownership in one transaction. A second
queue, copied database or launcher marker cannot establish which accepted
work the host owns. The SDK continues to write every job record.

**Gap:** The original SDK request did not specify how to extend a stopped
persistent host. Inspection exposed a race between checking it and starting it.

**Reach:** Custom stores need an explicit supported handoff contract before
this mode can serve them. Existing host identities and accepted keys stay in
place; this is not an alternate job engine.

**Verdict:** Sound. The component that owns durable state must own the atomic
handoff, rather than requiring applications to depend on private SQLite writes.

## Sound — medium confidence: require all-writer participation and explicit deployment exclusion

**When:** original-host preflight integration review.

**Choice:** A host request can wait for authorization while another process
acquires the worker. Submission and cancellation must reject that obsolete
writer before it commits, and maintenance must not mutate a refused adoption.
Worker fencing alone is insufficient. A previously running old binary which
does not implement the new contract must be stopped through the deployment
lifecycle; an advisory file only the new launcher reads cannot exclude it.

**Gap:** The initial blocker described atomic quiet acquisition, leaving the
scope of other writes and old-binary compatibility unstated.

**Reach:** Implementation must audit storage writes and service await points,
not merely add a startup option. Operational ownership still needs verification
at deployment. No protection against arbitrary same-user database modification
is claimed.

**Verdict:** Sound. It names the real boundary instead of promising that one
new acquisition method can control uncooperative processes. Exact API and
compatibility handling remain slice 1 work.

## Sound — medium confidence: retain ownership and eligibility beyond transient data

**When:** synthesis of three independent plan drafts.

**Choice:** A stale store handle must remain stale after the newer lease is
released, so the ownership generation must outlive the lease row. Likewise,
erasing a payload must not erase whether its recorded effects still require
reconciliation. A retained key with unknown eligibility blocks adoption; the
host cannot treat absence of the old error details as proof of safety.

**Gap:** The existing format retains accepted keys and terminal state but has
no persistent ownership generation or separate eligibility classification.
The initial quiet-acquire proposal did not settle retention-time information loss.

**Reach:** Implementation needs a reviewed storage-format transition and
custom-store contract. Inspection must not silently perform that transition.
This does not authorize a migration of any live store, or add an application
reconciliation decision maker. The SDK continues to refuse unresolved work.

**Verdict:** Sound. Safety facts must persist for as long as the decision relies
on them. Exact metadata layout remains delegated to the storage-contract slice.
