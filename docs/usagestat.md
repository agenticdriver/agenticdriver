# Usagestat integration

AgenticDriver reuses the existing public read contracts from `../usagestat`.
It does not fork its provider probes, credential discovery, or logo collection.
The inspected Usagestat endpoints are:

| API                 | SDK method                    | Purpose                                   |
| ------------------- | ----------------------------- | ----------------------------------------- |
| `GET /v1/providers` | `UsageStatClient.providers()` | Provider names, metadata, icon references |
| `GET /v1/usage`     | `UsageStatClient.usage()`     | Account snapshots and display metrics     |
| `GET /v1/limits`    | `UsageStatClient.limits()`    | Machine-readable quota resources          |

```ts
import { UsageStatClient, jsonlUsageSink } from "agenticdriver/usagestat";

const usagestat = new UsageStatClient({ url: "http://127.0.0.1:6736" });
const providers = await usagestat.providers();
const snapshots = await usagestat.usage();
const limits = await usagestat.limits();

// Pass this to AgenticDriver's onUsage option; the parent directory must exist.
const onUsage = jsonlUsageSink("./usage.jsonl");
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

The client retains Usagestat's `icon.path`, `icon.colorPath`, `icon.url`, variant
metadata, and brand color where the daemon supplies them. Filesystem paths refer
to the **Usagestat host**, so a remote browser cannot use them directly. Applications
should resolve known catalog entries into their own trusted asset pipeline and
preserve the source icon license/notices. Do not create an arbitrary filesystem
read endpoint or copy browser credentials to retrieve icons.

No copied logos or new artwork are needed for the SDK itself, which is headless.
The existing brand assets remain owned by Usagestat and their respective licensors.

## Per-run usage

Usagestat currently has no public event ingestion API. `onUsage` and the optional
JSONL sink provide the integration boundary for adding one later. The SDK does
not POST to an invented Usagestat endpoint.

Records now carry `agenticdriver.usage.v2`, stable host and optional account
identity, authenticated subject, timestamps, source, coverage, known subtotals,
complete measurements, and trusted host labels. Request metadata is excluded.
See [usage identity, accounting and retention](usage.md) for schema migration,
deduplication, unknown measurements and API-equivalent estimates.
