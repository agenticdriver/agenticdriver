# Usagestat integration

AgenticDriver uses Usagestat as an optional local or remote service dependency for usage storage, retention, forwarding, quotas and provider metadata.
It does not fork its provider probes, credential discovery, or logo collection.
The inspected Usagestat endpoints are:

| API                 | SDK method                    | Purpose                                   |
| ------------------- | ----------------------------- | ----------------------------------------- |
| `GET /v1/providers` | `UsageStatClient.providers()` | Provider names, metadata, icon references |
| `GET /v1/usage`     | `UsageStatClient.usage()`     | Account snapshots and display metrics     |
| `GET /v1/limits`    | `UsageStatClient.limits()`    | Machine-readable quota resources          |

```ts
import { UsageStatClient } from "agenticdriver/usagestat";

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
`GET /v1/limits/:instanceId` endpoint and returns that account's snapshot. Missing
or errored snapshots fail with `QUOTA_UNAVAILABLE`; provider-level fallback is
disabled. Duplicate bindings and assigning one upstream instance to different
host/account identities are rejected. The upstream connection is selected once
for the client, with redirects disabled. Raw `limits()`/`usage()` are administrative
reads of all accounts and should not be exposed directly to application users.

Usagestat's limits document currently identifies its schema as
`crossusage.limits.v1`; the client preserves that actual upstream value.
`fetchedAt`, `source`, and `errors` must be considered before treating a quota
snapshot as current. Quotas and per-run token metering are different observations.

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

Usagestat now implements an optional native run-ingestion contract. Enable it with
`usagestatd --run-usage-config /absolute/path/run-usage.json`; add `--no-poll` for
an ingestion-only service. The backend configuration, account bindings and
forwarding controls are documented in Usagestat's `docs/run-ingestion.md`. This
requires the backend implementation containing AD-030; older installations
without the route fail explicitly. No backend release has been published by this work.

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

Validate the real dependency locally:

```sh
# In Usagestat:
cargo test -p usagestat-core -p usagestat-daemon
cargo build -p usagestat-daemon
# In AgenticDriver:
npm run test:usagestat -- /absolute/path/usagestat/target/debug/usagestatd
```

The SDK test launches the supplied native binary with isolated fixture credentials,
private data and polling disabled. It verifies actual usage capture, schema/receipt
compatibility, host secret references, scoped reconciliation, backend restart and
failure without repeated generation, and separately attributed indexing/query embedding records. No live provider account is used.
