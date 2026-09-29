# Usagestat integration

AgenticDriver uses Usagestat as an optional local or remote service dependency for usage storage, retention, forwarding, quotas and provider metadata.
It does not fork its provider probes, credential discovery, or logo collection.
Released native readback is supported by Usagestat **`v2.0.0-alpha.4`**
(`bd5b7a162d7a3ddcf17995d3d20cb4b8cbd6d64b`). This release does not include
the optional run-ingestion service described below. Development builds may report
the same version, so a version string is not a capability handshake.

**SDK 0.2.0-rc.1 limitation:** desktop readback uses the correct native routes,
but `limits()` and `accountLimits()` in the published SDK call nonexistent
`/v1/limits` routes. The source correction tracked in
[#76](https://github.com/agenticdriver/agenticdriver/issues/76) uses native usage
snapshots as described here; it requires a subsequent package release.

The inspected Usagestat endpoints are:

| API                         | SDK method                        | Purpose                                         |
| --------------------------- | --------------------------------- | ----------------------------------------------- |
| `GET /v1/providers`         | `UsageStatClient.providers()`     | Provider names, metadata, icon references       |
| `GET /v1/usage`             | `UsageStatClient.usage()`         | Account snapshots and display metrics           |
| `GET /v1/usage`             | `UsageStatClient.limits()`        | Quota resources derived from snapshots          |
| `GET /v1/usage/:instanceId` | `UsageStatClient.accountLimits()` | Quota resources for an explicitly bound account |

```ts
import { UsageStatClient } from "@agenticdriver/sdk/usagestat";

const usagestat = new UsageStatClient({ url: "http://127.0.0.1:6736" });
const providers = await usagestat.providers();
const snapshots = await usagestat.usage();
const limits = await usagestat.limits();

// For per-run capture, configure the authenticated sink described below.
```

Every built-in adapter has a `usageStatId`, such as `codex`, `claude`, `gemini`,
`openai-api`, or `xai`. Multiple execution instances may map to the same provider;
apps should maintain explicit account/instance mapping when joining quotas.
Do not assume a provider-level quota snapshot belongs to every user or account.

`accountLimits` provides a lookup through an explicit mapping. Configure it on
the trusted application server with the upstream instance from Usagestat's
`instanceId` configuration (the emitted `providerId`/limits map key):

```ts
const accountQuotas = new UsageStatClient({
  url: "http://127.0.0.1:6736",
  accounts: [
    {
      hostId: "driver-installation-01",
      provider: "openai-personal",
      accountId: "account-personal-01",
      instanceId: "openai-api-personal",
      subjects: ["authenticated-user-id"],
    },
  ],
});
const quota = await accountQuotas.accountLimits({
  hostId: "driver-installation-01",
  provider: "openai-personal",
  accountId: "account-personal-01",
  subject: "authenticated-user-id",
});
```

Derive that identity from the trusted host and authenticated session. No match
fails with `QUOTA_UNBOUND` before any request. The client requests only the bound
`GET /v1/usage/:instanceId` endpoint and returns that account's quota resources. Missing
or errored snapshots fail with `QUOTA_UNAVAILABLE`; provider-level fallback is
disabled. Duplicate bindings and assigning one upstream instance to different
host/account identities are rejected. The upstream connection is selected once
for the client, with redirects disabled. Raw `limits()`/`usage()` are administrative
reads of all accounts and should not be exposed directly to application users.
The scoped native endpoint itself is still an administrative read, not an
independently authenticated end-user API. The application server owns the trusted
mapping and authorization; it must not accept identity fields from an untrusted
request or infer a binding from the provider family.

Usagestat has no separate limits endpoint. The client derives quota resources from
`/v1/usage` snapshots with `limitsFromSnapshots()` (schema
`agenticdriver.usagestat-limits.v1`, replacing the never-served upstream
`crossusage.limits.v1` literal): each progress line becomes a resource keyed by
its slugged label (`Session` → `session`, repeats get `-2`, `-3`), with `used`,
`limit`, `remaining`, `utilization`, `unit` (`percent`, `dollars`, `count` or
`count:<suffix>`), `resetsAt` and the original `label`. Failed providers (an error
source, any non-`ready` state or an `Error` badge) are listed in `errors`. Progress lines
with negative/nonfinite values, an unknown format or malformed reset time are omitted, so admission treats
them as unknown.
`fetchedAt`, `source`, and `errors` must be considered before treating a quota
snapshot as current. Quotas and per-run token metering are different observations.
Receiving a cached response does not refresh `fetchedAt`. Resource labels are
provider-defined and may change; inspect the returned keys rather than assuming
every account reports `session` and `weekly`. Freshness is the caller's explicit
`maxAgeMs` policy; the separate T3 compatibility adapter's TTL is not a native
API guarantee.

## Provider icons

Use the shared [provider catalog and asset guide](catalog.md) for browser-safe identity displays, account quota freshness and an allowlisted asset cache. It includes the same integration recipe for Brandstorm, LitAgent and AI Workspace.

The client retains Usagestat's `icon.path`, `icon.colorPath`, `icon.url`, variant
metadata, and brand color where the daemon supplies them. Filesystem paths refer
to the **Usagestat host**, so a remote browser cannot use them directly. Applications
should resolve known catalog entries into their own trusted asset pipeline and
preserve the source icon license/notices. Do not create an arbitrary filesystem
read endpoint or copy browser credentials to retrieve icons.

No copied logos or new artwork are needed for the SDK itself, which is headless.
The existing brand assets remain owned by Usagestat and their respective licensors.

## Per-run usage

Usagestat's development branch implements an optional native run-ingestion
contract (AD-030, commit `e3330d6f454d6b67f6b58247aeff78e84c3873d0`). **It is not
in a published backend release or the inspected live `main`.** Enable it with
`usagestatd --run-usage-config /absolute/path/run-usage.json`; add `--no-poll` for
an ingestion-only service. The backend configuration, account bindings and
forwarding controls are documented in Usagestat's `docs/run-ingestion.md`. This
requires that backend implementation; installations without the route fail
explicitly. Qualify a subsequent tested backend release before claiming released
ingestion compatibility. Always call `ingestionProtocol()` to verify
`usagestat.run-ingestion.v1` accepting `agenticdriver.usage.v2`; these are separate
contract versions, not a requirement for a `/v2` HTTP API. The native ingestion
daemon requires a loopback listener and its separate configured bearer credential.

Records now carry `agenticdriver.usage.v2`, stable host and optional account
identity, authenticated subject, timestamps, source, coverage, known subtotals,
complete measurements, and trusted host labels. Request metadata is excluded.
See [usage identity, accounting and retention](usage.md) for schema migration,
deduplication, unknown measurements and API-equivalent estimates.

```ts
const metering = new UsageStatClient({
  url: "http://127.0.0.1:6736",
  token: async () => readBackendCredential(), // application-supplied secret lookup
});
await metering.ingestionProtocol(); // checks agenticdriver.usage.v2 support
const driver = new AgenticDriver({
  providers: [selectedProvider],
  usage: {
    hostId: "driver-installation-01",
    accounts: { "openai-personal": "account-personal-01" },
  },
  onUsage: metering.usageSink(),
  onTelemetryError: reportCaptureFailure,
});
```

The native backend token must authorize this exact host, provider instance,
account and authenticated application subject. Missing SDK account bindings fail
before capture. `capture(record)` returns a versioned receipt after backend
commit; resending that same record deduplicates. `run(identity, eventId)` retrieves
its scoped record and delivery state for reconciliation. `retryForwarding(identity,
eventId)` explicitly queues a retained permanent forwarding failure after its
cause has been repaired. It never reruns the agent.

The host CLI uses existing secret references:

```json
{
  "usage": { "hostId": "driver-installation-01" },
  "usagestat": {
    "url": "http://127.0.0.1:6736",
    "tokenRef": { "file": "usagestat-ingestion.key" },
    "ingestionTimeoutMs": 1000
  }
}
```

Add these fields to the host configuration and give **every** provider instance
its explicit `accountId`. SDK tokens and Usagestat ingestion tokens are separate
credentials. `configuredDriver` reports an unacknowledged capture through its
`onTelemetryError` option or a redacted stderr message. URLs require HTTPS except
for loopback HTTP; redirects are disabled. The default 1-second capture timeout
(bounds 100–1500 ms) covers telemetry I/O and secret lookup, not agent execution.
The SDK still has no default run deadline or inactivity timeout.

For durable offline forwarding, use **SDK → local Usagestat → remote Usagestat**.
The local backend stores records and handles capacity, retries, retention and
remote reconciliation. The SDK contains a thin sender, with no second usage
backend or durable outbox. Direct remote capture also works, but an unavailable
first hop is a capture failure; durability begins after its acknowledgement.
Capture failures do not replace a successful run result, and idempotent run
replay does not regenerate or re-emit telemetry. Applications needing recovery
before capture acknowledgement must preserve the original report and resend it,
not execute the request again. Backend receipt expiry is authoritative; use a
record-level expiry when a cutoff must remain fixed across later retention-policy
changes.

The optional `jsonlUsageSink` remains a diagnostic append-only sink with no
rotation, deletion, synchronization or offline-delivery guarantee. Prefer the
native backend for durable usage collection. It does not add SDK records to
Usagestat's daily-import/provider-probe totals, which could double-count usage.

Validate the existing backend using its own native checks. The desktop read
integration can be exercised with the actual binary:

```sh
npm run test:usagestat --prefix apps/desktop -- /absolute/path/to/usagestatd
```

That check copies the actual daemon into a temporary profile with no provider
plugins and verifies its empty read contract. No provider can be polled. It works
with released alpha.4, which has no `--no-poll` flag, as well as the development
daemon. It does not invent accounts or run measurements.
To verify usage ingestion, run meaningful prompts on an explicitly configured real
provider and reconcile the host's actual usage records with the existing backend.

The quota correction has an opt-in read-only check against existing real accounts:

```sh
USAGESTAT_URL=http://127.0.0.1:6736 \
USAGESTAT_BINDINGS_FILE=/private/path/quota-bindings.json \
node --import tsx --test tests/usagestat-quota.test.ts
```

The private file is an array of explicit `UsageStatAccountBinding` objects like
the mapping above. The check keeps them in memory, issues only native usage
reads, verifies real ready/failed snapshots and admission, and rejects unbound
subjects without a request. It does not provision connections, install production
account mappings or invoke a model. An optional `USAGESTAT_CHECK_REPORT` path
records sanitized counts without account labels or credentials. CI without an
explicit real endpoint skips this live check; a skip is not account qualification.
