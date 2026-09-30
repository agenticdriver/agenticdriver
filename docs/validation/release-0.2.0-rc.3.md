# 0.2.0-rc.3 qualification and publication

Tracking: [AD-083 / #80](https://github.com/agenticdriver/agenticdriver/issues/80).
Immutable artifact source:
[`f319f173f55069a2ca0f91969bac99c169a063d2`](https://github.com/agenticdriver/agenticdriver/commit/f319f173f55069a2ca0f91969bac99c169a063d2).
Version **0.2.0-rc.3**, Python **0.2.0rc3**, wire protocol **1.0**.

RC.3 publishes the [desktop Overview](desktop-setup-2026-09-30.md) and explicit local/remote
[managed Codex runtime](../provider-runtimes.md). Installation, sign-in,
provider configuration, application permissions and model execution remain
separate choices. It retains RC.2's Usagestat 2.0.0 contract and qualified
Linux/native-provider scope. [Adoption and upgrade order](../rc.md)

## Exact artifacts and trusted publication

All seven [source checks](https://github.com/agenticdriver/agenticdriver/actions/runs/36656551940)
passed on the dedicated Prometheus runner: Linux desktop, minimum runtimes,
LTS/current language clients, current Node, account deployment, documentation and
fresh installation of the exact candidate archives. The candidate manifest is
clean and names the immutable source above. The new conditional private-cache
policy actually recovered storage during the documentation job, without lowering
the guard or touching shared services. [Recovery receipt](ci-cache-2026-09-30.md)

[npm](https://github.com/agenticdriver/agenticdriver/actions/runs/36658027884),
[Rust](https://github.com/agenticdriver/agenticdriver/actions/runs/36658030513) and
[Go](https://github.com/agenticdriver/agenticdriver/actions/runs/36658033195)
publication passed. Builds and checks stayed on Prometheus. npm's existing
hosted publish-only job uploaded the reviewed archive through OIDC; no browser
approval, replacement token or fallback publisher was used.

The public npm archive matched the candidate. An independent fresh registry
installation passed seven registry signatures and two attestations; the SLSA
statement binds the exact source and archive digest. npm `rc` is **0.2.0-rc.3**;
`latest` remains **0.1.0** and `alpha` remains **0.2.0-alpha.6**. Rust's actual
registry contents match the reviewed crate. Go's immutable module tag points to
the same source, and its publication workflow passed a fresh public-proxy install.
Python's reviewed wheel and sdist are GitHub downloads while the selected PyPI
organization approval remains pending. No personal publisher was substituted.

All nine [public release assets](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.3)
were downloaded anonymously and matched their exact sizes/SHA-256 values. The
release tag resolves to the candidate source. Previous releases remain unchanged.

[Manifest](../../release/0.2.0-rc.3/manifest.json) ·
[Checksums](../../release/0.2.0-rc.3/ASSET-SHA256SUMS) ·
[CI/publication](../../release/0.2.0-rc.3/ci-publication.json) ·
[Registry verification](../../release/0.2.0-rc.3/registry-publication.json) ·
[Public downloads](../../release/0.2.0-rc.3/github-publication.json)

## Packaged desktop and selected native connection

The exact Linux x64 desktop archive SHA-256 is
`e1192a674bf5e369bfa15ad7b1444de0d7fcfeef0cb392fcdc36edaf6113cf91`.
Its real bundled Node worker started an empty profile, inspected status without
downloading, then explicitly downloaded and verified the qualified official
Codex archive/executable. Configuration stayed unchanged, staging/lock files
were removed, and the installed executable survived restart. Six actual
Usagestat snapshots and usage settings remained available after restart. The
worker created no provider or grant and made no model call.

The ordinary user-local desktop installation now runs RC.3. Its original empty
provider/remote-host configuration was retained byte-for-byte, the RC.2 runtime
was kept, and the native application booted. Full native-window interaction was
not repeated. The earlier real wide/narrow Overview and installer interaction
receipts remain [feature evidence](managed-runtime-2026-09-30.md).

The independent Prometheus managed-runtime test host was upgraded from the source
candidate to the exact registry RC.3. Only that separate loopback test service
was stopped; its collected transient unit was recreated. The prior runtime was
retained, with private configuration, paired grants, native-account references,
runtime installation receipt and recorded usage preserved. Normal application,
RC.2 metering and CI services were preserved.

An independently installed registry client reached that host through the existing
trusted OpenSSH route. It read the verified installed runtime and refreshed the
selected Codex **0.157.0** native **Pro** account's nine reported models, including
**gpt-6-luna**. Management retained zero execution providers. Configuration and
paired grants matched before and after. These checks made no new model calls.

The real Luna/medium brand run, local/remote download cancellation, restart,
damaged-file refusal and four-language runtime reads were qualified in
[#79](managed-runtime-2026-09-30.md). Runtime/desktop implementation code is
unchanged between that checked source and RC.3; only version metadata, documentation,
CI cache policy and its checks changed. That prior real run is retained as
evidence rather than repeated solely for a version bump.

[Packaged desktop](../../release/0.2.0-rc.3/desktop-verification.json) ·
[Installed desktop](../../release/0.2.0-rc.3/desktop-installation.json) ·
[Test-host upgrade](../../release/0.2.0-rc.3/remote-upgrade.json) ·
[Native readback](../../release/0.2.0-rc.3/remote-readback.json) ·
[Runtime source comparison](../../release/0.2.0-rc.3/managed-runtime-code-identity.json)

## Consumer handoff and limits

Exact RC.3 coordinates and the additive runtime-management contract were handed
off on the existing [Brandstorm](https://github.com/hashimkarim/brandstorm/issues/1#issuecomment-5902799696),
[LitAgent](https://github.com/hashimkarim/agentic-literature-review/issues/5#issuecomment-5902799864),
[AI Workspace](https://github.com/hashimkarim/ai-workspace/issues/61#issuecomment-5902800067) and
[Usagestat](https://github.com/hashimkarim/usagestat/issues/29#issuecomment-5902800250)
issues. Direct T3 thread messaging was unavailable; GitHub comment delivery is
recorded explicitly. No app source, application auth or execution grant was
changed by this handoff.

The configured release watch discovered RC.3. Its automatic adoption is blocked
by oversized task packets for LitAgent/tooling and mismatched implementation
scope for AI Workspace; Brandstorm was still awaiting verified integration at
the recorded handoff. Publication does not establish app acceptance. The three
apps' [accepted RC.2 workflows](release-0.2.0-rc.2.md) remain prior evidence;
their existing work, enabled choices and private settings must be preserved.
Brandstorm's separately tracked initial-selection observation remains app-owned.
[Delivery receipt](../../release/0.2.0-rc.3/handoff-delivery.json)

Usagestat **2.0.1** was published after the SDK candidate checks. The tested
backend remains **2.0.0** until the new released binary passes its own integration
and maintenance checks; RC.3 does not claim that new backend qualification yet.
The SDK retains the existing backend API and introduces no parallel usage store.
Shared provider-icons remain **0.1.0-alpha.1**.

Installer qualification remains Linux x64/Codex 0.157.0. Other provider runtimes,
API billing modes, models, macOS/Windows and long-running production workloads
retain their separate gates. Reported account catalogs are not live model
qualification. There is no automatic desktop/runtime updater, public relay,
account/model/billing fallback, default generation deadline or default inactivity
timeout. Application data, source authorization and output acceptance stay owned
by the consuming app.
