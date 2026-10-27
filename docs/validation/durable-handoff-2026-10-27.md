# Durable host handoff qualification

This is **unreleased source evidence**, not a new published SDK version or
production deployment. The immutable runtime source is
`0c6e0f1bfcb625134a5ff067a9da53ad5b009d01`. Its private development archive
SHA-256 is `a84e063dcfe17de727839ccf5678c62c3f4bfb53fd5a1ee31dd417d18ba136cc`.
The package retains RC.3 metadata; these bytes are not the published RC.3 archive.

## Source and storage checks

The full SDK check passed on local Node 26: typecheck, **59 tests passed / one
existing live-Usagestat test skipped**, and build. The three new storage/service
files contain 25 passing checks. Independent implementation and qualifier reviews
are clean after their findings were corrected and tested.

The tests exercise actual private SQLite stores and SDK APIs, without provider
substitutes. They include distinct-process acquisition contention, unchanged
refusal despite expired payloads/leases, old-handle denial before maintenance,
retained key/eligibility preservation, v1 versus v2 ownership-cycle semantics,
late authorization during shutdown, real HTTP composition and existing-only
configuration loading. A real competing SQLite transaction also verifies that
release failure is reported while owned connections are still drained/closed.
Removing that cleanup produced the expected regression failure; restoring it
passed. Earlier review also caught retention occurring before a competing worker's
busy refusal; its regression failed before the pre-maintenance fence and passed
afterward.

Inspection is logically read-only. SQLite WAL coordination files can change;
filesystem immutability is not claimed. Missing/schema initialization and SDK
retention/recovery are excluded. This limitation is tested against a closed
store, not hidden by keeping another connection open.

## Real native request and recovery

The exact archive and qualifier were independently installed in a fresh private
consumer on Prometheus, using Node **24.16.0**. Both transferred SHA-256 values
matched. Existing application services, CI workers and native sign-in profiles
were retained. The private test host listened only on loopback and was controlled
through the existing trusted SSH destination.

A connection-only invocation first verified the selected account, provider model
catalog and handoff startup with zero model jobs. The full invocation ran from
**20:14:38 to 20:14:42 UTC on 2026-10-27**, using:

- Codex CLI **0.157.0**, native **ChatGPT Pro** subscription, existing account.
- Explicit provider `managed-codex`, model **gpt-6-luna**, medium reasoning.
- One native job submission; no account/model/billing fallback or automatic retry.

The public prompt asked for three brand directions for a repairable 18-litre
Amsterdam commuter backpack, recycled fabric, replaceable buckles, laptop
protection and a €120–€160 price. It requested names, taglines and positioning,
and prohibited unsupported certification/performance claims and file/tool use.

The returned directions were **Canal Standard**, **Polder Form**, and **Fix &
Flow**, with concise taglines and positioning tied to the supplied commuter,
material, repair and laptop brief. Manual inspection found a useful brand example,
with no unsupported certification or performance claim. This is SDK prompt
acceptance, not acceptance inside the Brandstorm application.

The run reported **6,026 input / 134 output tokens**, one SDK step. The private
usage JSONL contained exactly one schema-valid completed `cli-report` /
`cli-session` record, bound to the actual run, provider, model, host, account and
test subject; its usage matched the returned result. No subscription charge or
API-equivalent cost was invented.

The host then drained/closed and reopened through conditional handoff against
the **same** database. Job metadata, complete events, result and usage were
identical; replay generated no further metering record. A prior cancelled
storage-only prerequisite also remained readable. The prerequisite was created
and cancelled through public storage APIs with no provider dispatch; it is not
represented as a generated result.

Actual identifiers:

- Job `7b840df2-95e7-4774-903a-6e424d89f8a3`.
- Run `d76dc336-a0c2-476d-a0c6-00f3b5dde52c`.
- Private full receipt SHA-256
  `39543dd5ae6c0ca3090358d3d324838309f111f13ffbb6e97892f7b9d69df777`.

Final stored states were one completed and one cancelled job, with no lease.
The original saved SDK configuration matched its starting digest. Both qualifier
hosts closed; no uncertain accepted work or active test host remains. Full
receipts, test credentials and account identity stay in private validation state.

## Limits

This qualifies the selected Linux/Codex subscription path and the new SDK storage,
service and server composition. It does not qualify other providers/platforms,
shared production capacity, the original coordinator host, consumer rollout or
public package publication. The existing RC.1 downstream preflight still refuses
adoption until a supported artifact is selected there.

First opt-in adoption upgrades SQLite layout to v2. Older incompatible processes
must be excluded operationally. Unknown erased v1 outcomes remain blockers;
this feature neither invents reconciliation evidence nor repeats started work.
