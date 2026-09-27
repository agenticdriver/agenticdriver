# 0.2.0-alpha.3 publication evidence

Verified on 2026-09-27. This preview adds shared provider icons and optional
connection details to all four language packages and the Linux desktop.
Wire protocol remains **1.0**. Earlier published versions remain immutable.

## Reviewed source and changes

Source: [`d46e2292d0759ea24fed2035945d1ed8297e4357`](https://github.com/agenticdriver/agenticdriver/commit/d46e2292d0759ea24fed2035945d1ed8297e4357).

The shared component bundles the independent
[provider-icons library](https://github.com/agenticdriver/provider-icons), pinned
to `v0.1.0-alpha.1`, with its attribution. It supports monochrome/colour and
supported product-mark alternatives. Per-connection/provider icon preferences
remain presentation settings; they do not change execution, identity or billing.
Icon-only consumers do not depend on the SDK.

Optional `ProviderInfo.connection` metadata reports available runtime/CLI
versions, account status/method, subscription and email/name. All four clients
preserve and validate the optional fields. Missing metadata remains unreported.
The component masks email/name until Reveal, remasks on refresh, provider change
and disconnect, and does not persist identity in localStorage. Reported sign-in
and model availability do not establish successful inference.

The Rust shared-host test suite runs serially so fixture tests cannot cancel
one another. Explicit concurrency tests retain their own parallel operations.
The previous alpha.2 host-helper/profile-reader compatibility fixes remain included.

## Verification

- [SDK CI 36318567162](https://github.com/agenticdriver/agenticdriver/actions/runs/36318567162):
  all nine jobs passed on `prometheus-agenticdriver-01`, runner 21. Coverage
  includes minimum/current Linux runtimes, installed clients, verified TLS,
  containers, documentation, offline Codex/Claude contracts, packaged desktop
  checks and exact release-artifact installation. No hosted compute was used.
- Local SDK checks passed 341 tests, desktop checks passed seven, and release
  tooling checks passed 11 tests. Typecheck, builds and documentation passed.
- The exact CI desktop archive passed the Fedora native smoke: renderer
  isolation, provider setup, private account details, removal and strict style
  CSP. It bundles Node `v24.21.0`; Node options remained disabled.
- Fresh registry installations of JavaScript, Go and Rust passed the quickstarts
  over verified HTTPS. Python passed from both the reviewed wheel and source
  archive. The three packaged JavaScript application examples also passed.
- All nine public GitHub assets were downloaded anonymously and matched their
  reviewed SHA-256 and size. The npm registry archive is byte-identical to the
  reviewed CI/GitHub tarball. Release and Go tags point directly to the reviewed
  source above.

These checks use synthetic fixtures and offline native contracts. No real model
request or new provider-account sign-in was performed for this release.

## Immutable artifacts and publication

The [public prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.3)
contains nine assets. The [original manifest](../../release/0.2.0-alpha.3/manifest.json)
and [candidate checksums](../../release/0.2.0-alpha.3/SHA256SUMS) preserve the eight
package files from CI. The candidate zip retains their directory layout,
including the Go proxy files. `ASSET-SHA256SUMS` covers the flattened downloads
and desktop. Checksums are integrity records, not signatures.

| Artifact | SHA-256 |
| --- | --- |
| npm archive | `5c0cd3fbc471cf0dcf1bfe1798e4c1285ef8ec1e9dc44e419b751109e9f55460` |
| Rust crate | `62d3031e8471c920bcdb24da8e0810d9657de4b6e2cf70920d03bf3d77a42dc2` |
| Python wheel | `107aad13947a4f36630e1d37dfd13b23e2c3c98e5e60c1a7dd96fd25de02fec7` |
| Python source archive | `0bf2bbef0079ec7fba6f5497944da9d557191a07c342339ced15940a94a13478` |
| Linux desktop archive | `7a2cfdd4ef4ec603de1b64e2312012a7a6cf9a2331f354bbf243441411465f3d` |

npm lockfile integrity:
`sha512-cPpNVFixhrHQxVLvAU4fl4+pZUdtjQRq/+2u3jwOCRyRNGVs9KzSK5AbMGd5f4Wm35LMVJdPxPNKtInZ3KlTsw==`.

| Channel | Version | Status |
| --- | --- | --- |
| npm | `@agenticdriver/sdk@0.2.0-alpha.3` | Published and registry installation verified; `alpha` points here and `latest` remains `0.1.0`. |
| crates.io | `agenticdriver = "=0.2.0-alpha.3"` | Published through GitHub OIDC on Prometheus; reviewed contents and registry installation verified. |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.3` | Immutable module tag published; public-proxy installation verified. |
| Python | `agenticdriver==0.2.0a3` | GitHub wheel and sdist published and installed; PyPI organization approval pending. |
| Linux x64 desktop | `0.2.0-alpha.3` | Exact CI archive published; native smoke passed on Prometheus and Fedora. |

[Rust publication 36319919670](https://github.com/agenticdriver/agenticdriver/actions/runs/36319919670)
compared Cargo's repackaged contents with the reviewed crate before obtaining
the short-lived publishing identity. [Go publication 36319926119](https://github.com/agenticdriver/agenticdriver/actions/runs/36319926119)
verified the successful CI candidate before creating the module tag and testing
the public proxy. Both used Prometheus. npm used the authorized local member
sign-in and separate browser publishing approval with the original CI archive;
no registry credential was placed on Prometheus.

The [npm receipt](../../release/0.2.0-alpha.3/npm-publication.json),
[public GitHub download verification](../../release/0.2.0-alpha.3/github-publication.json)
and [desktop smoke receipt](../../release/0.2.0-alpha.3/desktop-verification.json)
record the verified results. No personal PyPI publisher or hosted-runner fallback
was introduced.

## Desktop and app handoff

The user-local desktop launcher now selects `0.2.0-alpha.3-20502d8cf6e7`.
Previous runtimes remain installed. Existing desktop sessions, application host
services, synthetic-validation services, private state and grants were not
restarted or changed.

The three application owners and website owner received the exact published
version/archive, source, CI and integrity receipt through their existing T3
threads. Their own branch commits, application tests and Prometheus acceptance
remain separate work; a handoff is not proof of adoption.

Applications retain their existing auth stack, private credential storage,
Usagestat identities, saved model choices and execution grants. A newer client
does not upgrade a running host. Use advertised capabilities and coordinate
shared-host upgrades after checking active work. Catalog availability, host
permissions, application enablement and live qualification remain distinct.
There is no model, account or billing fallback, and inference/inactivity timeouts
remain disabled unless configured by the application.

AD-042 remains open for PyPI and application acceptance. This release does not
qualify Windows/macOS/Linux ARM desktop builds, a public relay, signed installers,
automatic updates or additional live provider/account/model combinations.
