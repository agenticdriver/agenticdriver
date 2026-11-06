# Permanent source retirement

Ordinary deletion removes the document currently stored. It cannot stop an index
request that is still embedding or authorizing from committing afterward. Use
`retireContext` when an application needs a permanent commit fence for an immutable
source ID, including cleanup after an uncertain index request.

## The store owns the fence

Opt a **fresh, private SQLite file** into retirement explicitly:

```ts
const store = await SqliteVectorStore.open("/private/app-state/library-v2.db", {
  retirement: { maxSources: 100_000 },
});
```

This selects storage format 2. Opening a format-1 file with retirement enabled
fails; opening format 2 without that option also fails. There is no automatic
migration. Plan an app-controlled rebuild into a new file if needed.

A retirement marker and document removal commit in one transaction. Persistent
SQL guards reject later document inserts and updates, including statements
prepared by another connection before retirement. The fence covers the whole
corpus/namespace/source-ID tuple, across all revisions. A new immutable manifest
must use a new source ID. Neither cancellation nor an HTTP mutex supplies this
storage guarantee.

Markers are permanent and count against `maxSources` across the file. Capacity
exhaustion rejects a new retirement atomically; it never evicts an older fence.
Repeating an acknowledged tuple remains possible at capacity. Reusing that source
ID with a different retirement revision conflicts. The built-in memory store and
legacy SQLite format do not support retirement; custom stores must implement
`VectorStore.retire` with the same durable guarantee before acknowledging it.

## Separate authority and acknowledgment

Retirement requires both the token's `retrieval.retire` corpus grant and the
application authorizer's `retire` decision. Existing delete grants confer no
retirement authority. Keep the exact old revision authorized for cleanup and
reconciliation while preventing local reads and new indexing. The app still owns
its namespace, canonical source manifests and binding to the selected host.

```ts
const receipt = await client.retireContext({
  corpus: "library",
  sourceId: "immutable-paper-manifest-id",
  revision: "sha256-original-manifest",
});
```

All four clients expose this operation (`retire_context` in Python and Rust,
`RetireContext` in Go). A successful receipt echoes the exact request with
`retired: true` and `deleted: boolean`. `deleted: false` means no document was
removed by this call; the permanent fence still committed. An ordinary deletion
receipt is insufficient. Clients reject missing/false fence flags or mismatched
identities.

Hosts advertise `retrieval-retirement` when a configured corpus store supports
it. Discovery does not identify a corpus or grant access, and a mixed host may
still contain corpora that refuse retirement. The route uses the existing host
transport, concurrency and cancellation ownership. Retirement performs no
embedding calls and never silently retries uncertain mutations. After a lost
response, explicitly repeat the same tuple to reconcile the fence.

## Guarantee boundary

Acknowledgment prevents subsequent index commits for that scoped ID. It does not
stop embedding computation already in progress, cancel provider billing, quiesce
searches already reading a snapshot, or retract disclosed evidence. Applications
must revoke local reads/indexing immediately and revalidate returned search hits
against current permissions. Point-in-time authorization is not a read barrier.

The guarantee assumes the same intact database and guards. It does not survive an
administrator restoring an older database or removing its schema. Deletion is not
secure erasure of backups, snapshots or retained WAL files. Applications own
backup lifecycle, encryption and disclosure policy.

The operation and receipt contracts live in [retrieval types](../src/retrieval-types.ts);
[the SQLite owner](../src/sqlite-vector-store.ts) enforces the durable fence.

The [qualification record](validation/source-retirement-2026-11-06.md) records actual storage and four-language HTTP validation.
