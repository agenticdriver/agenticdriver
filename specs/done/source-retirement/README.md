# Source retirement rationale

An uncertain index request can outlive ordinary deletion: embedding or permission
work may finish later and commit the same immutable source again. Applications
need a storage acknowledgment before treating that cleanup as settled. The public
contract and its limits live in [permanent source retirement](../../../docs/source-retirement.md).

## Commit authority belongs to storage

A permanent marker and persistent SQL guard form one storage mechanism. A service
mutex orders only the work it already owns; cancellation does not prove an older
writer stopped. The SQLite owner therefore commits retirement and removal
atomically and rejects later writes, including independently prepared statements.
The guard protects commit ordering without promising computation or read quiescence.

This is an explicit irreversible operation with separate token and app-authorizer
permission. Reusing ordinary delete authority would silently widen existing
grants. A fresh opt-in database format preserves legacy storage semantics; an
automatic migration would make a new retention decision on the application's
behalf. Permanent markers have a bounded capacity and are never evicted.

The existing authorized corpus/namespace/source tuple and exact revision identify
the fence. Another random receipt ID would add neither authority nor reconciliation.
A lost response is reconciled by repeating that tuple. A new immutable manifest
uses a new source ID.

## Invariants and evidence

The [SQLite owner](../../../src/sqlite-vector-store.ts) owns persistence and schema
initialization. Both supported formats check and publish their schema under one
write transaction. Checking only before acquiring that transaction allowed a
legacy opener to downgrade metadata just created by a retirement opener; the
mixed-mode initializer regression pins this ordering.

[Storage tests](../../../tests/retirement-store.test.ts) exercise actual SQLite
connections and a second process, prepared late inserts/updates, reopen,
capacity/conflict rollback and missing/altered guards. The initializer regression
fails with the transaction fix removed and passes with it restored.
[Service tests](../../../tests/retirement-service.test.ts) cover independent grants,
exact revision authorization, reauthorization and the real HTTP route without
embedding execution. Four client implementations reject an ordinary deletion
receipt as retirement evidence. The [qualification record](../../../docs/validation/source-retirement-2026-11-06.md) separates real storage/HTTP evidence from application adoption.

## Application ownership

This SDK change does not provision LitAgent or any other application's semantic
corpus, select embedding weights, run embeddings, or change connections. Apps own
canonical manifests, namespaces, trusted host bindings and local revocation.
A retirement acknowledgment is a commit fence, not a guarantee of secure erasure,
provider cancellation or search-reader quiescence.
