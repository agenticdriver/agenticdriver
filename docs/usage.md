# Account-scoped usage

AgenticDriver records one aggregate metering event for each executed run. Run
metering, an account quota snapshot, an API-equivalent estimate, and an invoice
are distinct observations. The SDK does not derive subscription spend, available
quota, or an invoice amount from token counts.

Usagestat is the usage backend dependency. Its existing Rust core and daemon own
durable account history, quota observations, pricing/probes and provider metadata.
The SDK's responsibility is producing normalized execution measurements and
delivering them through a thin integration. The existing daily-report importer
does not accept individual run events, so AD-030 extends ingestion in Usagestat
and connects an optional SDK sink. It does not create a parallel usage backend
inside AgenticDriver. Applications that do not enable metering can use the SDK
without a running Usagestat service.

## Identity and explicit account binding

Configure a persistent host ID and opaque account IDs for any host that sends
records to shared storage or joins account quotas:

```ts
const driver = new AgenticDriver({
  providers: [personalOpenAI, companyOpenAI],
  usage: {
    hostId: "driver-installation-01",
    accounts: {
      "openai-personal": "account-personal-01",
      "openai-company": "account-company-01",
    },
    labels: { app: "brandstorm", environment: "development" },
    retentionDays: 30,
  },
  onUsage: (record) => usageStore.accept(record),
});
```

`personalOpenAI` and `companyOpenAI` are configured adapters with the corresponding
instance IDs. Account IDs are host assertions about their selected credentials;
the SDK does not discover or hash credentials to create an account ID. Preserve
the ID when rotating a credential for the same account. Assign a new binding and
provider instance when selecting a different account. IDs should be opaque
identifiers, without email addresses or credential values.

| Identity            | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `hostId`            | Stable namespace for an execution host installation.                             |
| `provider`          | The explicitly selected provider instance within that host.                      |
| `accountId`         | A trusted host binding to a billing/subscription account; absent when unbound.   |
| `subject`           | The authenticated application user, supplied by the host's bearer-token mapping. |
| `runId` / `eventId` | UUID of the execution and its single aggregate event.                            |

The same vendor can have many accounts. Never use `vendor`, model name, display
name, `authMode`, or `usageStatId` as an account join key. Include `hostId`,
`provider`, `accountId` and the authorized `subject` when selecting account data.
Deduplicate delivered aggregate events by `(hostId, eventId)`, independent of
labels or quota fetch time. An idempotent run replay returns the original result
without another usage event or provider invocation.

If `hostId` is omitted in an embedded driver, it gets a fresh process-local UUID
for that driver object. No account is inferred. Account bindings require an
explicit host ID. `init` writes a persistent random `usage.hostId` into new host
configurations; `--account-id` optionally binds the selected provider. Existing
configurations can add `usage.hostId` and each provider's `accountId`. Keep host
IDs unique when cloning installations. `driver.usageIdentity(provider, subject)`
returns the trusted host-side identity to use in a quota lookup.

## Measurements and coverage

Every measurement is optional. Absent means unknown. Explicit zero means the
adapter reported zero. Invalid, negative, nonfinite, fractional token counts,
unsafe integer sums, and impossible cache/reasoning subsets are omitted.

| Field                  | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `inputTokens`          | All reported input tokens, including cached input.                           |
| `cachedInputTokens`    | Cache-read subset of input tokens; never add it to input again.              |
| `outputTokens`         | Reported generated tokens including reasoning when known.                    |
| `reasoningTokens`      | Reported reasoning subset of output tokens; never add it again.              |
| `costUsd`              | Explicit provider-reported run cost. It is not inferred or invoice-verified. |
| `apiEquivalentCostUsd` | Reported dollar estimate at the reporting CLI/adapter's API rates.           |

Anthropic input totals sum uncached input, cache reads, and cache writes only
when all three counters are present. Missing cache components make that aggregate
unknown. Gemini output totals sum candidate and thought counters when both are
known; a reported total minus reported prompt count can also supply the output
total. A missing reasoning counter stays absent. Gemini CLI model aggregates
require the counter from every reported model entry. These mappings follow the
provider definitions for [Anthropic usage](https://platform.claude.com/docs/en/api/messages/create)
and [Gemini usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata).

Claude Code's local dollar figure is an estimate and may use configured rates.
Its value is carried as `apiEquivalentCostUsd`; it does not establish a charge
against a subscription. The SDK does not calculate another estimate from a price
table. See [Claude Code cost reporting](https://code.claude.com/docs/en/costs).

The `source` on a metering record identifies `provider-response`, `cli-report`,
`adapter-report` (the default for custom adapters), or `synthetic`. This is
provenance, not independent billing verification. Mock measurements are synthetic.

Each record contains:

- `usage`: totals only for fields reported by every started model step.
- `observedUsage`: sums of available reported values, with unknown steps excluded.
- `coverage.startedSteps` and `coverage.completedSteps`: model invocations begun
  and complete model turns received. These count logical steps, not HTTP attempts.
- `coverage.reportedSteps`: number of completed steps reporting each valid field.

For example, if step one reports 10 input and 2 output tokens, then step two
reports only 20 input tokens, the complete `usage` is `{inputTokens: 30}` and the
observed subtotal is `{inputTokens: 30, outputTokens: 2}`. If step two is interrupted
without a complete turn, complete totals are absent and the first step's known
measurements remain in `observedUsage`. Do not bill or infer remaining quota from
those subtotals. A failed/cancelled run may still have consumed provider resources.
Unreported measurements are not recoverable from the truncated stream.

## Versioned records, privacy and retention

The aggregate envelope is `agenticdriver.usage.v2`. It includes the identity,
model, vendor, auth mode, status, source, timestamps, duration, measurements,
coverage and trusted host labels. Its generated schema is
[`protocol/usage-record.schema.json`](../protocol/usage-record.schema.json).
`validateUsageRecord` also checks identity, timestamp and coverage consistency.

Version 2 replaces the prototype v1 metering envelope. Existing v1 records lack
host/account identity and measurement coverage; keep them in their original
namespace or migrate them with a verified external mapping. Do not automatically
join them to an account or reinterpret a historical CLI `costUsd` as invoiced
spend. The HTTP run protocol remains version 1.0; `apiEquivalentCostUsd` is an
additive optional usage field supported by all four bundled clients.

Request metadata is excluded from metering even when it contains keys such as
`subject`, `accountId`, `hostId`, or `app`. `usage.labels` is an explicit trusted
host configuration for short nonsecret labels. Keep credentials, prompts, email
text, document passages and private reasoning out of those labels. No prompt,
generated text, tool argument/result or credential field exists in the metering
schema. The JSONL sink validates and copies a record before writing it, rejecting
unknown versions and extra private payload fields.

`retentionDays` optionally sets each record's `expiresAt` relative to its finish
time. It is a storage policy hint and never a run timeout. A durable sink must
enforce that deadline for primary data, derived indexes and backups; use
`usageRecordExpired(record, now)` when accepting or retaining a record. Without
this option, retention belongs to the sink's configured policy. The local JSONL
sink appends private files but does not rotate or purge old lines; provide rotation
or use a sink with deletion support. Deleting metering records does not authorize
deleting idempotency/recovery barriers, which have a separate lifecycle.

`onUsage` remains optional and bounded to protect run delivery from a stuck sink.
It is not a guaranteed durable delivery queue. Record IDs and the v2 schema are
the contract for the durable ingestion implementation tracked separately in
AD-030. Reject unknown versions, preserve event IDs during retries, authenticate
the source host, validate its allowed accounts/subjects at ingestion, and isolate
read access by subject. A client-supplied JSON record is never sufficient proof
of its claimed identity.
