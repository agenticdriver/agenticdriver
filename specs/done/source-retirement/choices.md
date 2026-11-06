# Source retirement choices

## Persistent commit ownership

A retirement marker and persistent SQL trigger are one storage mechanism: the
marker records the decision, and the trigger prevents a late writer from ignoring
it. An HTTP mutex, promise cancellation or an empty delete result cannot prove
that an index still authorizing/embedding will not commit later. The store owns
that invariant without inventing a computation-quiescence promise.

## Explicit operation and format

Retirement is distinct from deletion and needs distinct authority. A new method
and endpoint preserve existing delete request/result layouts, including published
Rust struct literals. A required marker capacity opts a fresh SQLite file into
format 2; existing format 1 is neither migrated nor silently interpreted as fenced.
The feature adds one durable table and two SQL guards, not another execution host,
embedding service, identity store or application source registry.

## Fence identity

The corpus/namespace/immutable-source-ID tuple and exact authorized revision are
already the fence identity. The minimal design omits a random receipt UUID because
it would not add authority or reconciliation semantics. The app's trusted binding
continues to identify the selected host, descriptor, namespace and generation.
Acknowledgment echoes the exact request and `retired: true`; a duplicate may report
`deleted: false` while preserving the same permanent fence.

## Application and qualification scope

SDK implementation does not authorize application corpus provisioning or embedding
weight selection. Finding a cached model does not establish a selected runtime or
permission to load it. Retirement storage tests use actual SQLite domain data and
no embedding/model adapter substitutes. Service tests construct real production
adapter metadata with a resolver that refuses execution, proving retirement makes
no embedding calls.
