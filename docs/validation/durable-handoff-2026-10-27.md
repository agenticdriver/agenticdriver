# Durable host handoff qualification

This is **unreleased source evidence**, not a new published SDK version or
production deployment. The original native-request runtime source below is
`0c6e0f1bfcb625134a5ff067a9da53ad5b009d01`. Its private development archive
SHA-256 is `a84e063dcfe17de727839ccf5678c62c3f4bfb53fd5a1ee31dd417d18ba136cc`.
The package retains RC.3 metadata; these bytes are not the published RC.3 archive.
The CLI/minimum-runtime follow-up below records its revised source separately.

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

## CLI and minimum-runtime follow-up

The revised runtime at `9fb9e60376b10c50b09baf0fc0011bf8e7e53c3b` adds
`inspect-jobs` and invocation-only `serve --handoff-snapshot`. It also fixes two
defects found during qualification: readiness preceded signal-handler setup,
and validating an existing file with a raw open/close could drop SQLite's POSIX
locks. The existing separate-process race test failed on Node **22.13.0** before
the file-boundary fix and passed afterward. SQLite documents the
[raw-close locking hazard](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).
New inodes are closed under a private staging name before publication; existing
database validation uses metadata without raw descriptor closes. A crash during
staging cleanup may conservatively leave an extra link and block initialization.

Typecheck/build and **64 tests passed**, with one existing live-Usagestat skip.
All **30 focused storage/CLI tests** passed on Node 22.13.0; independent source
review passed. Unsafe permissions, symlinks and hardlinks still refuse without
changing the original database. No provider substitute was used.

The fresh private npm archive was installed on Prometheus with Node 24.16.0:
SHA-256 `f2cfb4cb370fa5d40184e0f6da910e8c2a8bfc465ee32f3f33e5467bbac327e7`.
Its installed CLI inspected/adopted the earlier real-job store twice, reading the
same job/run and exact seven-event sequence each time. Both SIGTERM shutdowns
released ownership. The completed result, cancelled prerequisite, two accepted
keys, private configuration and usage log were preserved. This replay submitted
**zero** model requests. CLI receipt SHA-256:
`462d8470489c27214ab64d904af548383ae597e74fb8d2907743a9a30f84556e`.
The replay fixture is the actual run from source `0c6e0f1` above; it is not a newly
generated result on `9fb9e60`.

A separate fresh-inference preflight initially refused **before submission**:
connection checking reported `pro`, then the next check reported `prolite`.
The qualifier had assumed a literal Pro-tier label. Three further read-only
checks confirmed a stable current native identity, ChatGPT authentication,
`prolite` and the exact Luna catalog entry, with zero model requests. That
label was never an account-identity guarantee or a user-selected requirement.
Independent review approved replacing the tier assumption with an explicit
native `ChatGPT` authentication check, which rejects API-key billing. The exact
configured account/profile, binary, model, reasoning and usage bindings remain
required; the provider-reported tier remains evidence. The original refused
receipt is preserved: SHA-256
`6c7762fa2079330be70ddb54e3e29c04b3cabcb68ec75d8471f72f6fa1c69de4`.

The corrected qualifier SHA-256 is
`b98d0fd306280fb397c3f714207045d04cadd7fe2727195d515a48b00a9f7913`.
It passed a zero-inference connection check, then submitted exactly one fresh
backpack-brand request against the same private archive. At **22:05:54–22:05:58
UTC on 2026-10-27**, Codex **0.157.0 / gpt-6-luna / medium** with native ChatGPT
authentication and reported tier **`prolite`** returned Canal Standard, Second
Gear and North Quay, each with a tagline and positioning grounded in the brief.
The answer was reviewed as a useful SDK example; no consumer application
acceptance is inferred.

The run reported **6,026 input / 111 output tokens**, one SDK step and exactly
one schema-valid account-bound metering record. Restart preserved job, run,
events, result and usage with no further inference. The saved source config was
unchanged and both hosts closed. No account/model/billing fallback occurred;
no subscription charge or API-equivalent cost was invented.

- Job `d50e7296-ca08-40a0-b30f-d02170fd47ac`.
- Run `61478750-fb49-4bf1-b642-5e4158a2348d`.
- Private native receipt SHA-256
  `967512b8de429c4a841ec59915b2eb1803e149e7a604a8911afec0f424c4ad2b`.

## Limits

This qualifies the selected Linux/Codex subscription path and the new SDK storage,
service and server composition. It does not qualify other providers/platforms,
shared production capacity, the original coordinator host, consumer rollout or
public package publication. The existing RC.1 downstream preflight still refuses
adoption until a supported artifact is selected there.

First opt-in adoption upgrades SQLite layout to v2. Older incompatible processes
must be excluded operationally. Unknown erased v1 outcomes remain blockers;
this feature neither invents reconciliation evidence nor repeats started work.

## Shared vector-storage boundary follow-up

The corrected filesystem boundary also serves vector storage, whose previous
raw open/close had the same lock hazard. A real SQLite/Python competing-process
regression fails against the previous vector implementation on Node 22.13 and
passes after sharing the corrected boundary. It checks SQLite busy/locked codes,
not arbitrary I/O failure. Independent review and typecheck passed; the full SDK
check passed **65 tests**, with one existing live-Usagestat skip, and build.
This is storage-level verification without provider execution. The native-run
receipts above remain bound to their recorded sources; no new inference or
retrieval-model qualification is claimed for this extraction.
