# 0.2.0-rc.1 qualification and publication

Tracking: [#71](https://github.com/agenticdriver/agenticdriver/issues/71).
Immutable package source:
[`726fd821a31d7c4462db36bfdf3884ab028f9b7a`](https://github.com/agenticdriver/agenticdriver/commit/726fd821a31d7c4462db36bfdf3884ab028f9b7a).
The version is **0.2.0-rc.1**, Python **0.2.0rc1**, protocol **1.0**.
Stable npm `latest` remains **0.1.0**; `alpha` remains **0.2.0-alpha.6**.

Published on **2026-09-29** after the checks below passed, including successful
Claude execution after its reported allowance reset and all three app-owned
acceptance records. A signed-in account and reported catalog are not counted as
successful generation. The [public prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.1)
contains the exact SDK archives and Linux desktop.

**Post-release finding, 2026-09-29:** optional SDK quota admission calls
`/v1/limits`, which Usagestat never served. Desktop `/v1/usage` readback and the
recorded generation/consumer checks remain valid; they did not qualify this quota
adapter. [#76](https://github.com/agenticdriver/agenticdriver/issues/76) tracks the
source correction to native usage snapshots. The published RC.1 artifacts retain
the defect until a subsequent release; see [the current integration contract](../usagestat.md).

## Exact artifacts and publication

All seven [source checks](https://github.com/agenticdriver/agenticdriver/actions/runs/36569610094)
passed on Prometheus: Linux desktop, minimum runtimes, LTS/current language
clients, current Node, account deployment images, documentation and the exact
candidate archives. CI installs and compiles packages and runs pure/process
checks; it neither supplies model responses nor invokes a provider.

The [CI and publication receipt](../../release/0.2.0-rc.1/ci-publication.json)
preserves source and job identities. The three publication workflows passed:
[npm](https://github.com/agenticdriver/agenticdriver/actions/runs/36572172627),
[Rust](https://github.com/agenticdriver/agenticdriver/actions/runs/36572201867)
and [Go](https://github.com/agenticdriver/agenticdriver/actions/runs/36572254660).
Builds, checks and Rust/Go publication ran on Prometheus. npm used its existing
hosted publish-only OIDC exception, without browser approval or a fallback token.

Fresh public-registry npm, Rust and Go installs and both exact Python archives
passed installation/compilation checks. npm's archive matched byte for byte;
`npm audit signatures` verified seven package signatures and two attestations.
The public SLSA attestation names the exact source above.
[Registry receipt](../../release/0.2.0-rc.1/registry-publication.json)

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| npm tarball                | `d5f13587d78e4d887ad4879a14e317db7aba34ce1d3544ecba8239e940060822` |
| Python wheel               | `5fcb3ed1ae6f925a0444b456af8a0da4d559748705cdb9fa9a89c929760721af` |
| Python source distribution | `ce58dff533ffb712afaf2841d801326a4139c7108021a2fec4ec1213cebd4f4e` |
| Rust crate                 | `7086dec6dbc407cdcb3064a65bbe663ef4fa7299c2ac90a8627dab1fee8f65d3` |
| Go module zip              | `1ef9715d82d57d9abdb34f9b9ec2135b788e4602a4076b0e8a3d58c03c8724dd` |
| Linux desktop tarball      | `ccdc038db9a079ce3b813afd0567c33d551eaa10e8d96f42b79deeb75654c50b` |

The [manifest](../../release/0.2.0-rc.1/manifest.json),
[candidate hashes](../../release/0.2.0-rc.1/SHA256SUMS) and
[download hashes](../../release/0.2.0-rc.1/ASSET-SHA256SUMS) identify the reviewed
bytes. Checksums establish integrity, not an independent signature.
The GitHub candidate zip retains the manifest's directory layout. Python's
selected organization is still awaiting PyPI approval; no personal publisher
or substitute package is used.

All nine public GitHub downloads were fetched anonymously over HTTPS and matched
their expected sizes and SHA-256 digests. The release tag points to the immutable
source above. [Public download verification](../../release/0.2.0-rc.1/github-publication.json)

## Installed language clients and real generation

The final host runs on a separate Prometheus loopback endpoint reached through
the existing trusted OpenSSH destination. It preserves native profiles and
provides private, expiring, application-scoped credentials. There is no grant
expansion on a regular application host. All four installed language clients
completed the following meaningful public/example-content requests on the
selected Codex **0.157.0**, **gpt-6-luna / medium**, existing Pro subscription:

| Client     | Prompt                                                                                             | Run                                    | Reported input / output |
| ---------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| JavaScript | Three brand directions from the checked-in concrete AgenticDriver brief                            | `04a66a93-0c3e-4a6e-a0b6-ec9ad22235a0` | 6,121 / 256             |
| Go         | The same concrete brand brief                                                                      | `3746ccd4-e275-4dfb-a65d-7c62048c0abe` | 6,121 / 266             |
| Python     | Compare supplied public Lewis/Liu literature notes and separate findings from proposed experiments | `a6b44b96-0e71-40ce-86ee-2903f03bb5ad` | 6,202 / 216             |
| Rust       | Draft a reply to the supplied historical public alpha.5 release handoff                            | `f11c34eb-26d8-4d84-a4f6-1ad6f7f7fbae` | 6,203 / 215             |

The results were read for usefulness and supported scope. The literature answer's
per-token retrieval suggestion is a proposed experiment, not an established app
implementation. The email prompt describes a historical release; its answer is
not evidence of current adoption. No email was sent and no private paper/library
or mailbox content was submitted. The Rust run reported 4,864 cached tokens and
13 reasoning tokens; the others reported zero for those fields.

The JavaScript run preceded the Claude-only correction; its client and Codex
execution files are byte-identical in the final archive. Python/Go/Rust archive
contents were compared with the final candidate, and fresh registry installs
were also checked. These are independent explicit Codex examples, not retries
or fallback replays of the failed Claude brand request.
[Client receipt](../../release/0.2.0-rc.1/language-client-generation.json)

Claude Code **2.1.282**, **claude-haiku-4-5-20251001**, remained signed in and
reported fourteen models, but hit the real native five-hour subscription limit.
The original failure and the corrected single-attempt `RATE_LIMITED` result are
preserved in [the quota receipt](claude-limit-2026-09-29.md). There was no
account/model/billing fallback, overage enablement or pre-reset retry loop.
Failed or interrupted usage is unknown when the provider did not report it.

At 15:11 UTC, fresh metadata confirmed the same Claude account, subscription,
version and selected Haiku model. The installed Python client completed the
original brand brief in run `b9fa7219-8d60-4c09-8d48-d605dda33b86`, with 3,750
input / 967 output / 0 cached tokens and a reported API-equivalent estimate of
$0.008585. The reviewed 171-word answer supplied three distinct directions,
taglines, colour pairs and motifs. Promotional phrases remain creative options,
not verified product claims. This was one deliberate post-reset check, with no
automatic retry or account/model/billing change.

## Retrieval and boundaries

[Actual local embedding and retrieval evidence](local-retrieval-2026-09-29.md)
uses pinned Transformers **4.3.0** and q8 **all-MiniLM-L6-v2**, revision
`751bff37182d3f1213fa05d7196b954e230abad9`, with 384-dimensional vectors.
The input is the complete public Lewis RAG paper plus permitted Markdown/email
examples. The ordinary SDK installation does not include that optional runtime.

The existing index was upgraded to the exact final SDK files without reindexing
or changing grants: three documents and 201 chunks, with the same logical
database digest. All four final clients queried it and returned the same four
paper passages and scores. Their citation helpers accepted the original valid
model response and rejected its original invalid source ID as `INVALID_CITATION`.
Those parser checks replay recorded actual output, not simulated generation.
[Host upgrade](../../release/0.2.0-rc.1/retrieval-host-upgrade.json),
[four-client retrieval](../../release/0.2.0-rc.1/retrieval-client-verification.json)

The development receipt also records actual scope/revision/deletion boundaries,
restart persistence, embedding queue cancellation and grounded Codex/Claude
answers. The corresponding implementation is unchanged in the RC. Citation IDs
establish reference membership; they do not prove factual truth or entailment.
SDK retrieval acceptance does not automatically qualify a consuming app's RAG UI.

[The integrated Linux review](security-real-2026-09-29.md) records actual tool
approval/denial, subject and executor restrictions, argument replacement,
single-use pairing, revocation, transport restrictions and interrupted-effect
replay. The [code comparison](../../release/0.2.0-rc.1/security-code-identity.json)
confirms that its boundary-enforcement modules are unchanged. The first native
adversarial email remained source material and did not acquire tool permissions.
This is bounded observed evidence, not a universal security certification.

Dedicated account containers use the final CI image files, retained isolated
account volumes and verified HTTPS. The final Codex container completed run
`badc839b-ea5d-48e2-8bda-bd47ffe119a6` (6,090 input / 303 output tokens), then
cancelled `49f71d58-1d79-4b83-a4ee-5b2bd0bd45b3` after progress. Both account
containers passed stop/restart, catalog and isolation probes. Sibling-account
credentials were rejected with 401, and untrusted TLS certificates were rejected
without making model requests.
[Credential/TLS receipt](../../release/0.2.0-rc.1/container-credentials-tls.json)
The earlier [full account-boundary receipt](account-isolation-2026-09-29.md)
remains a baseline. After the allowance reset, the final Claude container
completed `685d8707-7cd0-44b9-a74a-c7c9720a72bb` (3,711 input / 669 output,
0 cached tokens; API-equivalent estimate $0.007056) and cancelled
`7e4b1048-6ff4-40fe-ba35-9e0079636adf` after progress, with usage unreported.
Both owned containers were then stopped; the final probes found zero remaining
native processes or invocation directories. Native profiles and account volumes
were retained. [Final account-container receipt](../../release/0.2.0-rc.1/account-container-verification.json)

The Claude checklist suggested host failover and configuration export/import
beyond the supplied facts. Those suggestions are not qualified SDK capabilities
and were not accepted as an application artifact. The original response is
retained without a repair generation. This check qualifies execution and
container lifecycle; content still requires an application's review.

## Desktop installation and connection UX

The final Linux archive's renderer, worker, bundled runtimes and Codex execution
are identical to the reviewed UI candidate; the final change affects Claude quota
classification and documentation. The packaged worker's real local Codex brand
run `73035aa7-cd28-4ee9-9818-9d5d3659d6c6` reported 10,482 input and 241 output
tokens. Catalog refresh during execution did not cancel it.

Checks exercised empty onboarding, local/remote provider settings, native version
and subscription metadata, masked identity with keyboard Reveal/Hide, single-use
pairing, same-profile/same-port restart, revocation, and a managed outbound SSH
route with paired-client recovery. The tested route forwards a Prometheus
loopback endpoint to the Fedora desktop host; provider credentials stay local
to their execution computer. Remote settings were read back and the original
display name restored.

At 1920×1080 and 390×844 the shared provider panel stayed within the viewport.
Issue #74 corrected the provider-card minimum width and stale alpha label.
Actual Usagestat data was read from the existing local service, including its
freshness/errors; that check does not establish run ingestion or infer that a
local quota belongs to a selected remote provider.

The user-local launcher selects **0.2.0-rc.1-aae825e35d24**. The installer retained
the prior runtime and left existing profile bytes unchanged. The native process
and worker started with the existing empty profile, zero providers and zero
remote hosts, without disabling the sandbox. An initial launch inherited T3's
separate XDG configuration directory; that owned process was stopped before
starting with the intended existing profile explicitly.

Native boot is checked separately from interactive acceptance. The latter uses
the actual packaged renderer and worker through T3's private HTTP preview bridge;
full native GUI interaction and other operating systems are not claimed.
[Desktop receipt](../../release/0.2.0-rc.1/desktop-verification.json)

## Consumer applications

All three apps pin the exact npm RC and lock its public registry integrity.
The owning threads preserve their application's authentication, stored data and
provider choices. Each uses a separate expiring test grant; these are not
production credentials and do not alter the regular hosts.

- **Brandstorm:** the mounted selected-public-source answer passed cancellation,
  explicit resume, source quotation review, save/reload, disabled-selection
  rejection and a narrow layout check. The app preserves `RATE_LIMITED` without
  automatic retry. Source `5510058` passed Prometheus run `36573455828`.
- **AI Workspace:** a public release message produced a reviewed reply draft;
  edit/reload/repeated acceptance retained one saved draft. Cancellation and
  service recovery preserved selection without rerunning generation. Source
  `a9fc615` passed all five jobs in Prometheus run `36573338840`. No message was
  sent; direct source navigation is not RAG/citation entailment verification.
- **LitAgent:** the full public-paper answer and separately reviewed writing
  proposal passed source support and exact-quote checks. Explicit acceptance
  changed only a disposable manuscript; restart, repeated acceptance and request
  replay preserved the same file/history without another generation. Two
  interrupted requests are confirmed terminal cancelled. Settings retained
  enabled Haiku and disabled/unselected Codex. The mounted browser inspected
  saved results and citations; acceptance/recovery actions used actual app APIs.
  Final receipt source `dd7ff9d` passed Prometheus run `36590244371`.

LitAgent's initial question constrained a numerical comparison to the wrong
source section and was rejected; its four completed calls remain recorded.
After the prompt's section reference was corrected, one exact-quote repair was
needed in the successful workflow. The accepted TeX draft still has advisory
percent-sign formatting warnings and is not certified compilation-ready. A
support-review explanation mislabels a section while the actual quoted passages
and source IDs remain correct. The app did not relax its source validators to
make the check pass. These are observed editorial limits, not hidden successes.

[Immutable app records and CI](../../release/0.2.0-rc.1/consumer-acceptance.json)
and [SDK host terminal reconciliation](../../release/0.2.0-rc.1/app-host-reconciliation.json)
separate completed, cancelled and unreported usage. Earlier alpha.6 results are
preserved as historical baselines, not relabelled as RC requests. No model call
was repeated merely because byte-identical archives became available on npm.

## Remaining scope

This RC qualifies only its recorded Linux routes, versions, accounts and models.
Other reported models, native providers, API billing modes, macOS and Windows
need their own live checks. There is no automatic model/account/billing fallback,
default generation deadline or default inactivity timeout. Long-duration
availability, production capacity, every application's private-data workflow and
external side effects require separate acceptance. Python's PyPI organization
approval remains pending.
