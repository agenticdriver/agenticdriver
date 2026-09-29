# 0.2.0-alpha.6 publication evidence

Published on 2026-09-28 under [#70](https://github.com/agenticdriver/agenticdriver/issues/70).
The immutable source is
[`5ac1e6fdf24dc226177d7167bd1611a2c6c0ae44`](https://github.com/agenticdriver/agenticdriver/commit/5ac1e6fdf24dc226177d7167bd1611a2c6c0ae44).
Wire protocol stays **1.0**; stable npm `latest` stays **0.1.0**.

## Shipped behavior

The SDK and desktop contain no built-in mock provider, seeded connection,
canned model response or fake embedding adapter. New profiles start empty;
CLI initialization requires `--provider` before writing files. Legacy mock
configuration fails with `MOCK_PROVIDER_REMOVED`. Remote management rejects the
removed kind without changing the stored revision. The removed exports and
host-first management upgrade sequence are in [migration notes](../migrations.md).

Examples use a concrete product brief, attributed public research notes and an
actual release handoff draft. The former simulated provider acceptance suites
and preview modes were deleted. Their historical receipts remain historical;
the current checks do not claim equivalent coverage. Real vector stores and
embedding adapters remain available, with explicit account configuration.

## Checks and real connections

All six [exact-source CI jobs](https://github.com/agenticdriver/agenticdriver/actions/runs/36449845337)
passed on `prometheus-agenticdriver-01`, runner 21: desktop packaging, three
runtime/client rows, documentation, and candidate installation. Current checks
include 23 SDK pure/process/validation tests, three desktop security/packaging
checks, eight CI-boundary checks and eleven release-archive checks. They do not
simulate model responses or call a provider from CI.
[CI receipt](../../release/0.2.0-alpha.6/ci-receipt.json)

Six [source-candidate requests](real-providers-alpha6-2026-09-28.md) exercised the
three prompts on each real Prometheus subscription account. The exact final CI
npm archive was then installed on a separate Prometheus host and in a fresh
application. Codex CLI **0.157.0**, **gpt-6-luna / medium**, completed the brand
prompt; Claude Code **2.1.282**, **claude-haiku-4-5-20251001**, completed the email
handoff prompt. Catalog refresh during both requests left generation running.
All four installed language clients read the real management inventory: two
connected providers and nine connection definitions. These metadata checks made
no additional model requests. [Final artifact receipt](../../release/0.2.0-alpha.6/final-real-verification.json)

Only the selected two models were executed; the reported nine Codex and fourteen
Claude models are not all live-qualified. Model completion is not editorial or
consumer application acceptance. The initial Claude literature output contained
an unsupported qualifier, recorded with the original evidence. No private
library/mailbox data was used and no email was sent. Real embeddings/RAG, native
tools, account containers and complete consumer flows remain separate checks.

## Published artifacts

| Channel           | Version                            | Verification                                                                            |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| npm               | `@agenticdriver/sdk@0.2.0-alpha.6` | Exact archive bytes, fresh registry install, signatures and source provenance passed.   |
| crates.io         | `agenticdriver = "=0.2.0-alpha.6"` | Trusted upload, reviewed contents and fresh registry installation passed.               |
| Go                | `clients/go@v0.2.0-alpha.6`        | Immutable source tag and fresh public-proxy installation passed.                        |
| Python            | `agenticdriver==0.2.0a6`           | GitHub wheel/sdist installed; PyPI organization approval remains pending.               |
| Linux x64 desktop | `0.2.0-alpha.6`                    | CI archive, public download, actual worker connection checks and native startup passed. |

The [npm publishing step](https://github.com/agenticdriver/agenticdriver/actions/runs/36451905839)
used OIDC without member browser approval. npm processing exceeded the workflow's
three-minute availability poll, so that workflow ended red after a successful
upload. Once the version became available, independent verification matched its
exact archive and source attestation; a fresh `npm audit signatures` verified
seven registry signatures and two attestations. No repeat upload or token fallback
was attempted. [npm receipt](../../release/0.2.0-alpha.6/npm-publication.json)

[Rust publication](https://github.com/agenticdriver/agenticdriver/actions/runs/36451909600)
and [Go publication](https://github.com/agenticdriver/agenticdriver/actions/runs/36451913323)
passed on Prometheus. npm's existing hosted job is publish-only. All four final
language artifacts were installed and compiled independently; installation alone
is not model execution. [Installation receipt](../../release/0.2.0-alpha.6/fresh-installed-verification.json)

All nine [GitHub release downloads](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.6)
were fetched anonymously and matched their reviewed size/SHA-256. The release and
Go tags point directly to the source above. The
[manifest](../../release/0.2.0-alpha.6/manifest.json),
[candidate hashes](../../release/0.2.0-alpha.6/SHA256SUMS),
[download hashes](../../release/0.2.0-alpha.6/ASSET-SHA256SUMS) and
[public download receipt](../../release/0.2.0-alpha.6/github-publication.json)
are preserved. Checksums are integrity records, not signatures.

## Installed desktop and app handoff

The user-local launcher selects `0.2.0-alpha.6-4168060e8bcb`. The actual native
main process started against the existing profile, with zero providers and zero
saved remote hosts. The process was absent at a later check, with an empty log and no stale desktop
lock; its exit cause was not observed. Earlier installed versions remain available; actual account
profiles and shared application services were preserved.

The packaged worker passed real remote pairing, native version/subscription
discovery, saved-host recovery after restart, and temporary grant revocation.
Its runtime/UI files match the final build. All 87 SDK JavaScript files in the
desktop match the final npm archive. T3 inspected the identical renderer through
the development HTTP bridge at 1920×1080 and 390×844, with masked account identity
and no horizontal overflow. This does not claim complete native Electron GUI
interaction. [Desktop receipt](../../release/0.2.0-alpha.6/desktop-verification.json)

Separate 24-hour real validation grants are prepared for the three app owners on
the alpha.6 Prometheus host. They preserve the previous execution scope and do
not add management, tools, jobs, sessions or retrieval privileges. Existing
regular/alpha.5 hosts remain unchanged. App owners retain their authentication,
private credential storage, saved selections and adoption checks. No default
generation deadline or inactivity timeout is introduced.
