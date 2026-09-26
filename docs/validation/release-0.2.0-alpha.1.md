# 0.2.0-alpha.1 publication evidence

Verified on 2026-09-26. This preview packages the SDK, shared provider/connection
component and Linux desktop companion. Wire protocol remains **1.0**. Package
publication does not qualify every provider, account or discovered model.

## Reviewed source and checks

- Source: [`19ed7d3a7a75601f708c061b66857913e976e6c4`](https://github.com/agenticdriver/agenticdriver/commit/19ed7d3a7a75601f708c061b66857913e976e6c4).
- [SDK CI 36262465036](https://github.com/agenticdriver/agenticdriver/actions/runs/36262465036):
  all nine jobs passed on `prometheus-agenticdriver-01` (runner 21). This covers
  three Linux runtime combinations, installed language clients, verified TLS and
  containers, documentation, offline Codex and Claude contracts, the sandboxed
  packaged desktop and exact release-archive installation. No hosted compute.
- Local SDK checks passed 338 tests; desktop checks passed seven tests. The
  [panel validation](panel-alpha-2026-09-26.md) additionally records desktop and
  narrow-browser checks under strict style CSP, removal confirmation/cancellation,
  stale revisions and older/read-only host capability gates.
- Fresh installations passed the four language quickstarts over verified HTTPS.
  Go and Rust used their published registries; JavaScript used the reviewed npm
  archive pending npm sign-in, and Python used both the reviewed wheel and sdist.
  Installed JavaScript recipes for all three application types also passed.

## Immutable release assets

The public [GitHub prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.1)
contains nine assets. Every uploaded asset's GitHub digest and size matched its
local reviewed file before the draft was published. Both the release tag and the
Go module tag point directly at the reviewed source; previous tags were not moved.

The [manifest](../../release/0.2.0-alpha.1/manifest.json) and
[candidate checksums](../../release/0.2.0-alpha.1/SHA256SUMS) preserve the CI
bundle's eight package files. `agenticdriver-0.2.0-alpha.1-candidate.zip` preserves
that full directory layout. The release's `ASSET-SHA256SUMS` covers flattened
assets, including the desktop. Checksums are integrity records, not signatures.

| Artifact | SHA-256 |
| --- | --- |
| npm archive | `905ff90683c1161e80166960333cb23662c5ff906932878d1d69dee862cf8b28` |
| Rust crate | `734017e3f55ca9c9cdcf894c6a73c6b19a1657438549fdabbd530196cec96eec` |
| Python wheel | `b94e4f16eeaeccb83fd09ff17b6fa916652b6f61bcb1366e0c02777f33b1f8ea` |
| Python source archive | `237fcb1ac1c3ddb86b43bbe4d52b7e078e1285177bc4b440ee0c3eda8b5035e7` |
| Linux desktop archive | `6d267d61d1b76713410ca1a0a604f894d45edccfc5d9677fcbefbdb87bb7a700` |

The expected npm archive integrity is
`sha512-lkxbgsXHQ/xIL5jXrMBEBmrxKEojacxHsoHnhBuoLzXbdRZ3RlSvL77eh+sewfpGZwWzounKBMhmEBCImCgj/Q==`.

## Publication status

| Channel | Version | Evidence or remaining gate |
| --- | --- | --- |
| npm | `@agenticdriver/sdk@0.2.0-alpha.1` | Reviewed tarball is on GitHub; npm upload held after the strict TypeScript compatibility finding below; follow-up target is alpha.2. |
| crates.io | `agenticdriver = "=0.2.0-alpha.1"` | Published through GitHub OIDC on Prometheus; registry checksum exactly matches the reviewed crate. |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.1` | Published module tag; fresh public-proxy installation passed. |
| Python | `agenticdriver==0.2.0a1` | Reviewed wheel and sdist published as GitHub downloads; PyPI organization approval remains pending. |
| Linux x64 desktop | `0.2.0-alpha.1` | CI archive published; packaged native smoke passed on Prometheus and Fedora. |

[Rust publication 36263769997](https://github.com/agenticdriver/agenticdriver/actions/runs/36263769997)
compared Cargo's repackaged contents with the reviewed crate before acquiring
the short-lived crates.io identity, uploading and verifying the registry result.
This is live evidence of the configured Rust trusted publisher on Prometheus.

[Go publication 36263772376](https://github.com/agenticdriver/agenticdriver/actions/runs/36263772376)
created `clients/go/v0.2.0-alpha.1` only after validating the exact successful CI
candidate, then installed through the public module proxy and checksum database.

npm's existing member credential expired. Its upload was then held when LitAgent's
application check found a TypeScript declaration mismatch: `managedHost().management`
was incompatible with `serve()` under `exactOptionalPropertyTypes`. The runtime
checks still pass. The follow-up alpha.2 fixes the SDK declaration and adds an
installed-consumer regression check; alpha.1 archives/tags are unchanged. There is
no replacement npm token on Prometheus and no hosted-runner fallback.
PyPI remains under the selected organization; no personal publisher was used.
The [release page](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.1)
records subsequent channel status updates.

## Desktop and application adoption

The exact downloaded desktop archive passed the native smoke with renderer
isolation, provider setup/removal and strict style CSP. Its bundled Node runtime
is `v24.21.0`. The user-local installer retained previous runtimes and updated
the managed application-menu launcher to `0.2.0-alpha.1-398245e30885`. It did not
restart the existing desktop or shared application/synthetic host services.

All three application owners received the public artifact, source, CI and
integrity receipt. Brandstorm's integration checkout, LitAgent's existing stack
and AI Workspace's application settings remain owned by their active threads.
Their final npm dependency upgrades target the corrected alpha.2 and await its
verified registry receipt; sending a handoff is not evidence of adoption.
Brandstorm's isolated strict-CSP component and seven contract checks passed;
LitAgent identified the strict declaration issue, and AI Workspace requested a
public validated profile-metadata reader. Both SDK changes belong to alpha.2.

Applications retain their auth stack, private credential storage, saved model
choices and current grants. The alpha client does not upgrade a running host.
Old hosts remain usable for their advertised features; management/removal and
provider sign-in controls must follow capability and permission checks. Existing
LitAgent credentials are not silently expanded to grant management access.

No live model request was made for this publication. Usagestat remains the
accounting dependency. Provider availability, execution permission, application
enablement and live qualification remain separate. There is no account/model
fallback or default inference/inactivity deadline.

AD-042 remains open for the outstanding registry and application gates. Windows,
macOS, Linux ARM, public relay hosting, signed installers and automatic updates
are not qualified by this release.
