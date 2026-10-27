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

## Sound — medium confidence: logical inspection allows SQLite coordination files

**When:** inspection implementation review.

**Choice:** Inspecting a closed WAL database can create SQLite's WAL and shared
memory files even through a read-only connection. Inspection promises unchanged
job/lease data, no database/schema initialization and no retention or recovery;
it explicitly does not promise an untouched directory. A closed-store regression
checks database bytes and the allowed bookkeeping boundary.

**Gap:** The initial spec used “read-only” without distinguishing logical data
from SQLite coordination. Independent review reproduced that distinction. The
SQLite immutable option would disable locking/change detection and be unsafe on
a database another process can change, so it is not used as a workaround.

**Reach:** Operators who require zero filesystem effects must not treat this
API as that guarantee. Inspection is a diagnostic observation, never an adoption
receipt. No original/live store has been inspected by this implementation.

**Verdict:** Sound. It uses SQLite's real consistent-read mechanism and states
its limits rather than building a second snapshot engine or bypassing locking.

## Sound — medium confidence: opt-in layout transition and fresh owned handle

**When:** storage/service implementation pass.

**Choice:** Successful first acquisition upgrades the original database to v2
inside its transaction, adding a persistent generation and one eligibility bit
per job. It returns a fresh connection/handle; existing objects remain stale,
so a delayed request cannot borrow a replacement service's authority. The
service drains and closes its acquired handle, even when lease release fails;
the original caller still owns its original handle.

**Gap:** The plan delegated exact storage/API shape. Mutating an old handle
into the new owner would let callbacks already holding that object inherit
new authority. A new parallel job engine or copied queue would lose identity.

**Reach:** `acquireQuiet` is optional for custom stores. The ordinary v1 format
and startup stay unchanged until opt-in; old binaries must be excluded before
using v2. Failed/erased legacy evidence cannot be made safe automatically.
The eligibility bit retains only whether handoff is safe, not erased error
content; unsafe and unknown outcomes both remain blocked.

**Verdict:** Sound. It preserves one SDK state owner and existing accepted keys,
without exposing a new network/admin endpoint or application identity system.

## Sound — medium confidence: initial v1 comparison is state-based, then generations persist

**When:** final implementation review.

**Choice:** A v1 lease-only cycle can return to the same snapshot because v1
has no durable generation. Initial adoption compares that current state and
atomically fences cooperating old handles. No accepted/started record may
vanish through such a cycle. Later v2 ownership cycles advance the persistent
generation and invalidate earlier observations even when job rows are unchanged.

**Gap:** The plan initially described every committed change as observable,
which cannot be retroactively guaranteed without changing the legacy store
before inspection. The public inspection API already disclaimed a change counter.

**Reach:** First adoption is not a proof that nothing happened since inspection.
It proves the matching quiet state at acquisition plus new writer fencing.
An old binary must still be excluded operationally. Tests pin both behaviors.

**Verdict:** Sound. It states the actual safe boundary rather than inventing
historical evidence or an automatic migration before the operator's opt-in.
