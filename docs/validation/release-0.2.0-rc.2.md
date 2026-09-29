# 0.2.0-rc.2 qualification and publication

Tracking: [#77](https://github.com/agenticdriver/agenticdriver/issues/77).
Immutable artifact source:
[`91dc52292c627a6febed102a8198c56f35d3afc9`](https://github.com/agenticdriver/agenticdriver/commit/91dc52292c627a6febed102a8198c56f35d3afc9).
Version **0.2.0-rc.2**, Python **0.2.0rc2**, wire protocol **1.0**.
This update corrects native Usagestat quota reads and qualifies the released
Usagestat **2.0.0** integration. It preserves the earlier RC's provider and
platform scope. All nine [public release downloads](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.2)
were fetched anonymously and matched their expected sizes/digests. The release tag
points to the exact source above. [Download verification](../../release/0.2.0-rc.2/github-publication.json)

## Exact packages

All seven [SDK checks](https://github.com/agenticdriver/agenticdriver/actions/runs/36640743553)
passed on `prometheus-agenticdriver-01`: desktop, minimum runtimes, LTS clients,
current Node, account images, documentation and freshly installed candidate
archives. The first attempt failed at the disk-space preflight before tests.
Only the dedicated SDK runner's Go cache and private Docker build cache were
reclaimed; the same source then passed. Shared services, images, credentials and
other runners were preserved.

[npm](https://github.com/agenticdriver/agenticdriver/actions/runs/36642583503),
[Rust](https://github.com/agenticdriver/agenticdriver/actions/runs/36642586234) and
[Go](https://github.com/agenticdriver/agenticdriver/actions/runs/36642589053)
publication passed. npm used the existing hosted publish-only OIDC exception;
all builds/checks and Rust/Go publication ran on Prometheus. No npm browser
approval or fallback publisher credential was used.

The public npm archive matched the reviewed bytes, and a fresh registry install
runs the upgraded normal host. Seven registry signatures and two attestations
passed `npm audit signatures`; the SLSA statement names the exact source above.
The `rc` tag is **0.2.0-rc.2**; `latest` remains **0.1.0** and `alpha` remains
**0.2.0-alpha.6**. Rust contents match the reviewed crate; Go's immutable tag
points to the source above and its publisher verified a fresh public-proxy install.
Python remains a reviewed GitHub wheel/sdist while the selected PyPI organization
awaits approval.

[Manifest](../../release/0.2.0-rc.2/manifest.json) ·
[Archive checksums](../../release/0.2.0-rc.2/ASSET-SHA256SUMS) ·
[CI/publication](../../release/0.2.0-rc.2/ci-publication.json) ·
[Registry verification](../../release/0.2.0-rc.2/registry-publication.json)

## Stable Usagestat and real usage

The public Usagestat `v2.0.0` Linux x64 daemon was checksum-verified:
`dc3338f29b111e629191ac1d196dc39c51f71ac016881dd3f960add59af3acb9`, from source
`fbf84796d80fd5567516cec2e11b0784e7c187db`.

- Native quota readback used the existing real daemon on port 6736: six snapshots,
  five explicitly selected administrative bindings, two ready and three
  unavailable accounts, including a failed snapshot with cached metrics. Fourteen
  native reads and five unbound-subject rejections passed without model calls or
  installing these administrative test bindings on an execution host.
- The packaged desktop's real worker read all six native snapshots, retained its
  usage settings over restart, and started with zero providers/connections in a
  fresh profile. The ordinary desktop installation was upgraded and booted with
  its original empty profile intact. Full native GUI interaction was not rerun.
- A separate loopback host on Prometheus ran the exact RC archive, with the
  existing native Codex and Claude accounts and a separately authenticated stable
  Usagestat service. An existing trusted OpenSSH route carried client traffic.
  Credentials stayed in private files; model credentials stayed on Prometheus.
- Fresh discovery reported Codex **0.157.0**, signed-in Pro, nine catalog models;
  Claude Code **2.1.282**, signed-in Pro, fourteen catalog models. Only
  **gpt-6-luna / medium** and **claude-haiku-4-5-20251001** were selected for
  new execution. Discovery is not qualification of other reported entries.

| SDK prompt | Exact model | Reported input | Reported output | Cached input | API-equivalent estimate |
| --- | --- | ---: | ---: | ---: | ---: |
| Three brand directions from the AgenticDriver brief | gpt-6-luna | 6,129 | 252 | 4,864 | Not reported |
| Email draft from the dated public alpha.5 release handoff | claude-haiku-4-5-20251001 | 3,846 | 1,326 | 0 | $0.010476 |

These are native measurements, including runtime overhead. Cached tokens are a
subset of input; the Claude estimate is not a subscription charge. Both runs
completed while their catalogs were refreshed. The Codex answer met the requested
brand format. The Claude draft preserved the historical handoff facts and pending
PyPI approval, but appended an inaccurate word-count claim; it needs that edit
before use. No email was sent. [Prompts and run receipt](../../release/0.2.0-rc.2/sdk-real-runs.json)

Automatic backend lookup succeeded **before** any explicit resubmission of the
records. Identical resubmissions returned duplicate receipts. A Usagestat restart
retained the records, and credentials for other application subjects could not
read them. Capture remains separate from quota snapshots and daily-import totals.
No parallel SDK usage backend was introduced.

[Quota readback](../../release/0.2.0-rc.2/quota-readback.json) ·
[Packaged desktop](../../release/0.2.0-rc.2/desktop-verification.json) ·
[Installed desktop](../../release/0.2.0-rc.2/desktop-installation.json)

## Existing regular LitAgent host

The SDK-owned normal host at port 7433 now uses the exact registry RC.2. Its
existing ingestion-only service at port 7436 was upgraded from the development
alpha.3 binary to released Usagestat 2.0.0. All thirteen existing stored records
read back unchanged, first from an isolated SQLite backup and then from the
upgraded running service. Private configuration and credentials matched before
and after; host/account/subject identities, grants, service enablement and saved
application choices were preserved. Previous runtimes and a private backup were
retained. The live database was not replaced.

The upgraded normal host returned both native catalogs with the existing
application credential. This maintenance made no model calls and did not enable
the app's saved disabled selections. The usual native readback daemon at port
6736 was unchanged. [Upgrade receipt](../../release/0.2.0-rc.2/regular-host-upgrade.json) ·
[Host readback](../../release/0.2.0-rc.2/regular-host-readback.json)

## Consumer acceptance and scope

All three apps pin the exact registry RC and have passing Prometheus CI. Each
completed one real Codex/Luna workflow through its actual application, with
automatic stable-backend capture matching the supplied identity and reported
usage. Account identity remained masked and management stayed read-only.

| Application | Tested source | Prometheus CI | Actual workflow |
| --- | --- | --- | --- |
| Brandstorm | [`3dfc5e6`](https://github.com/hashimkarim/brandstorm/commit/3dfc5e64b22dfae9f05db1d3be53169e8b1b6673) | [36643612843](https://github.com/hashimkarim/brandstorm/actions/runs/36643612843) | [Source question over selected public Mozilla excerpts; two source-linked priorities and explicit unknown prices/naming guidance.](https://github.com/hashimkarim/brandstorm/blob/8797a18bf57eba3f912296b86dc6e65e008211a6/docs/validation/agenticdriver-rc2-2026-09-30.md) |
| LitAgent | [`6bdbebd`](https://github.com/hashimkarim/agentic-literature-review/commit/6bdbebd86c31afe24076c333bb364aa2a2db14a6) | [36643470627](https://github.com/hashimkarim/agentic-literature-review/actions/runs/36643470627) | [Key findings from public Lost in the Middle reading notes; supported qualified finding remains a pending proposal.](https://github.com/hashimkarim/agentic-literature-review/blob/6bdbebd86c31afe24076c333bb364aa2a2db14a6/docs/validation/driver-rc2-consumer-2026-09-30.md) |
| AI Workspace | [`26f11db`](https://github.com/hashimkarim/ai-workspace/commit/26f11db5e6cbfc68a500bf83c99b6a5fcedd8c7f) | [36643237463](https://github.com/hashimkarim/ai-workspace/actions/runs/36643237463) | [Summary, reply and task from the public dated SDK release handoff; one reviewed and manually edited draft persisted without duplication.](https://github.com/hashimkarim/ai-workspace/blob/9172c7727c1b4cdb2d1a18f06a9795786a39e873/docs/validation/mail-ui-rc2-2026-09-30.md) |

[Immutable consumer receipts](../../release/0.2.0-rc.2/consumer-acceptance.json) ·
[All five real records reconciled](../../release/0.2.0-rc.2/usage-reconciliation.json)

Brandstorm retained the answer and selection, and rejected disabled execution
before streaming. Its initial setup had one selection-propagation failure:
the SDK emitted the expected event, but the outer form stayed empty until a
read-only panel snapshot and repeat selection. This was not a verified use of
the visible Refresh button. [App follow-up #3](https://github.com/hashimkarim/brandstorm/issues/3)
tracks reproduction and the connection-URL readiness in its selection bridge.
No SDK-owned defect is established, and first-click onboarding is not certified.
The test question also retained an old naming suffix; the answer marked that
unsupported request unknown without another inference call.

LitAgent kept its supported finding as a pending proposal through restart;
normal connection settings and disabled selections remained unchanged. This
used public reading notes, not a new full-PDF retrieval evaluation. AI Workspace
retained exactly one reviewed/edited draft after reload and repeat acceptance,
and recovered its checkpoint from an app-backend restart without replay. No
private mailbox/library content, external send or automatic application artifact
acceptance was needed. Wider source and editorial limitations remain in each
application's receipt.

Historical [RC.1](release-0.2.0-rc.1.md) retrieval, account-container, security and
wider cancellation results remain prior evidence; this update does not claim to
have rerun every earlier scenario. Other providers/models, API billing routes,
macOS and Windows retain their separate qualification requirements. Temporary
validation connections are distinct from ongoing application credentials. No
application auth migration, fallback account/model/billing, default generation
deadline or default inactivity timeout was added.
