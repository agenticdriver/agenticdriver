# 0.2.0-alpha.2 publication evidence

Verified on 2026-09-26. This application preview contains the SDK, shared
provider/connection component and Linux desktop companion. Wire protocol remains
**1.0**. Alpha.1's published archives and tags remain unchanged.

## Changes qualified by this release

Application acceptance found a declaration mismatch between
`managedHost().management` and `serve()` under TypeScript
`exactOptionalPropertyTypes`. Alpha.2 fixes that composition, preserves synchronous
management snapshots, and makes the installed-consumer check enforce strict
optional-property declarations without skipping dependency checks.

`readConnectionProfile` is now a public backend export. It validates private
profile metadata without loading a bearer credential or contacting the host.
Expired metadata remains displayable; the execution client still rejects an
expired connection. This removes the need for application-owned profile parsers.

The shared panel distinguishes an empty host with management access from a
connection with no provider grants. Removing the final provider returns to
first-provider onboarding, including from the Models tab and after reload.
Read-only connections show access guidance without management actions.

## Reviewed source and checks

- Source: [`02d2e3a6d7a9a9a4a893debc8e8a6d971d1dcaf5`](https://github.com/agenticdriver/agenticdriver/commit/02d2e3a6d7a9a9a4a893debc8e8a6d971d1dcaf5).
- [SDK CI 36265757403](https://github.com/agenticdriver/agenticdriver/actions/runs/36265757403):
  all nine jobs passed on `prometheus-agenticdriver-01`, runner 21. Checks cover
  three Linux runtime combinations, installed language clients, verified TLS,
  containers, documentation, offline native Codex/Claude contracts, the sandboxed
  packaged desktop and exact candidate installation. No hosted compute.
- Local SDK checks passed 339 tests; desktop checks passed seven. The exact
  downloaded desktop also passed the Fedora native smoke with renderer isolation,
  provider setup/removal and strict style CSP.
- A fresh npm installation from the public GitHub archive passed without npm
  authentication. Its installed identity, lockfile URL/integrity and public
  management/profile-reader exports matched the reviewed candidate.
- Fresh quickstarts passed for all four languages over verified HTTPS. Go and
  Rust used their published registries; JavaScript used the reviewed archive,
  and Python used both the reviewed wheel and source distribution.

## Immutable release assets

The public [GitHub prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.2)
contains nine assets. Every uploaded asset's digest and size matched its local
reviewed file before publication. The release tag and Go module tag point
directly at the reviewed source. Anonymous release access and the npm archive
download were verified independently.

The [manifest](../../release/0.2.0-alpha.2/manifest.json) and
[candidate checksums](../../release/0.2.0-alpha.2/SHA256SUMS) preserve the CI
bundle's eight package files. The candidate zip preserves their directory layout,
including the Go module files. `ASSET-SHA256SUMS` on the release covers flattened
downloads and the desktop. Checksums are integrity records, not signatures.

| Artifact | SHA-256 |
| --- | --- |
| npm archive | `a49dcc4c7d146d1f91fae58638d8b901f4ef6f51c873dd227070de54e4c2ebee` |
| Rust crate | `04c1b3b9e6867603aacb3ef0db36c07b2d50b195a04e9ea0c5c0b0f3cb3d6fb0` |
| Python wheel | `9aa20f406691695c4ccf992174466cb974b4125a1326a19d15f95ad896952534` |
| Python source archive | `33ca83ccbe051673631cc33e1a072f50998a22d22573e0bcdd4c595ff6926d03` |
| Linux desktop archive | `0e934734a3bf018655e53a8eb197a48514d6042160a19f2d279631f25eb57a96` |

The npm lockfile integrity is
`sha512-JSeVyraqRvcHbBVDfQzx9QnNuZ7xqi7dGSPuzBvbKvzsO4EUSOyF2rX5GhvsIRs5YpEAC0KNjBwgeUwUHxVa2Q==`.

## Publication status

| Channel | Version | Evidence or remaining gate |
| --- | --- | --- |
| npm | `@agenticdriver/sdk@0.2.0-alpha.2` | Public GitHub archive install verified; registry upload awaits renewed member sign-in. Stable `latest` remains `0.1.0`. |
| crates.io | `agenticdriver = "=0.2.0-alpha.2"` | Published through GitHub OIDC on Prometheus; reviewed artifact verified. |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.2` | Published module tag; fresh public-proxy installation passed. |
| Python | `agenticdriver==0.2.0a2` | Wheel and sdist are public GitHub downloads; PyPI organization approval remains pending. |
| Linux x64 desktop | `0.2.0-alpha.2` | CI archive published; packaged native smoke passed on Prometheus and Fedora. |

[Rust publication 36266990626](https://github.com/agenticdriver/agenticdriver/actions/runs/36266990626)
compared repackaged contents with the reviewed crate before acquiring the
short-lived crates.io identity, uploading and verifying the registry result.
[Go publication 36266992513](https://github.com/agenticdriver/agenticdriver/actions/runs/36266992513)
validated the exact successful CI candidate before creating its immutable module
tag and installing through the public proxy and checksum database. Both used
Prometheus. No personal PyPI publisher or hosted-runner fallback was introduced.

## Desktop and application adoption

The installed desktop runtime is `0.2.0-alpha.2-e6ea0c26dc00`, bundling Node
`v24.21.0`. The user-local installer retained previous runtimes and updated the
managed application-menu launcher. Existing desktop sessions, private state,
shared application hosts and synthetic-validation services were not restarted.

LitAgent independently checked the final CI archive in a disposable copy of its
actual app: typecheck/build passed, 276 tests passed with two optional skips, and
native T3 browser checks verified both empty-host permission states and reload.
This prepublication acceptance is separate from final app dependency adoption.

All three application owners received the verified public archive, exact source,
CI and integrity receipt for final manifest/lockfile updates and their own
Prometheus checks. Their branch commits and application acceptance are tracked
separately; sending a handoff does not prove adoption.

Applications retain their auth stack, private credential storage, saved model
choices and current grants. A new client does not upgrade a running host or expand
a token's scope. Provider catalog availability, host permissions, app enablement
and live qualification remain separate. No real model request was made for this
publication. Usagestat remains the accounting dependency; there is no model,
account or billing fallback and no default inference or inactivity deadline.

AD-042 remains open for the outstanding registry and application gates. Windows,
macOS, Linux ARM, public relay hosting, signed installers and automatic updates
are not qualified by this release.
