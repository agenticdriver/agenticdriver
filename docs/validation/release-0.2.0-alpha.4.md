# 0.2.0-alpha.4 publication evidence

Verified on 2026-09-27 under [issue #59](https://github.com/agenticdriver/agenticdriver/issues/59).
This preview improves local/remote setup and saved-host recovery. Earlier
published versions remain immutable. Wire protocol stays **1.0**.

## Reviewed source and behavior

Source: [`a8d296e2944dbda7de326c525870c7769d28c4b9`](https://github.com/agenticdriver/agenticdriver/commit/a8d296e2944dbda7de326c525870c7769d28c4b9).

The desktop previews invitation destinations without contacting them, checks
saved hosts using authenticated protocol metadata, supports renaming and replaces
same-address credentials while retaining the saved host ID/preferences. Failed
replacement keeps the previous profile. Setup distinguishes expiration,
rejection, network failure and TLS failure.

Connection routes distinguish same-computer, HTTPS/proxy-prefix and existing SSH
tunnels. Forward/reverse recipes target the selected local host and request a
loopback listener. The desktop does not start SSH or open firewall ports.
Invitation creation does not establish network reachability.

The shared provider component hides stale account details and management/model
controls after failed refresh or sign-in-status polling. A disconnected snapshot
with a saved connection enters recovery too; a snapshot without a saved connection
still follows the application's onboarding permissions. Explicit retry retains
same-connection provider selection and device-local preferences. It does not
repeat configuration, pairing or inference. All four languages bundle this fix;
the panel API and independently pinned provider-icons `v0.1.0-alpha.1` are unchanged.

## Verification

- [Exact-source Prometheus CI 36346455297](https://github.com/agenticdriver/agenticdriver/actions/runs/36346455297)
  passed all nine jobs on `prometheus-agenticdriver-01`, runner 21. Checks cover
  the packaged desktop at both widths, offline Codex/Claude contracts, containers
  and verified TLS, minimum/LTS/current runtime combinations, documentation and
  building/installing the exact candidate artifacts. No hosted compute was used.
- Local checks passed 341 SDK tests and 14 desktop tests, typecheck/builds and
  documentation. Native Electron checks passed at 1340×883 and 390×844.
- The exact CI desktop archive passed both native checks on Fedora, preserving
  renderer isolation, strict style CSP, disabled Node options and bundled Node
  `v24.21.0`. Its shared component matched the reviewed source bytes.
- Native T3 acceptance used a disposable desktop preview and mock-only remote
  host. Invitation preview, native Enter pairing, connection checks, rename,
  shutdown and explicit recovery passed. The measured viewport was 2103×1183;
  browser resize timed out, so no narrow T3 acceptance is claimed. Temporary
  fixtures were stopped and their listening ports checked closed.
- A separate [two-machine SSH fixture](invitation-destinations-2026-09-27.md)
  verified a reverse route to Prometheus, one-use invitation replay rejection,
  and the remote loopback bind. Its temporary tunnel/host/grant were cleaned up.
- Fresh Rust/crates.io and Go/public-proxy installations passed the quickstarts over verified HTTPS. JavaScript and Python wheel/sdist passed from the reviewed archives, including the three packaged JavaScript app examples. Fresh npm registry installation subsequently passed too.
- A fresh application installed the public GitHub JavaScript URL directly,
  verified its exact lockfile URL/integrity and ran all three bundled app examples.
  See the [public URL install receipt](../../release/0.2.0-alpha.4/github-javascript-install.json).
- All nine public GitHub downloads matched their reviewed SHA-256 and size.
  The release and Go tags point directly to the source above. The GitHub JavaScript download is byte-identical to the reviewed candidate archive; the npm registry download now matches too.

All checks used synthetic providers, metadata fixtures or isolated offline native
contracts. No live model request, real account payload or provider sign-in was
part of this release. The superseded version-only CI run `36345367103` was
cancelled before publication after T3 found the saved-host recovery edge case
fixed in [issue #60](https://github.com/agenticdriver/agenticdriver/issues/60).

## Artifacts and destinations

The [public prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.4)
contains nine assets. The [original manifest](../../release/0.2.0-alpha.4/manifest.json)
and [candidate checksums](../../release/0.2.0-alpha.4/SHA256SUMS) preserve the eight
package files from CI. The candidate zip retains their directory layout, including
Go proxy files. `ASSET-SHA256SUMS` covers the flattened downloads and desktop.
Checksums provide integrity records, not signatures.

| Artifact | SHA-256 |
| --- | --- |
| npm archive | `3d5ee438194b28f4ab4c128f0aa7076ac31dba5598d44e92638b6906296cc2e1` |
| Rust crate | `a31115aac34a6bc38997cf0129241549cd71bc6f450553a0e65aade7ac8a6db0` |
| Python wheel | `f9ca5d1c9bca622307b38a912b092d67b6f42a8f5f942e3117212cbdaaff280b` |
| Python source archive | `0c657b4b48f4254c3b23d835ced20eb5a66352ac5d5391a2e946c731065aa071` |
| Linux desktop archive | `8b9076cf07d8c09aa2be439c962635af1954b29f4405410c62f7996167c85503` |

JavaScript lockfile integrity:
`sha512-TR3rntOQ8uPtFUU+LkRPIy6WjcNryQGKca9YZ5mGj2/q5YDGM3/dx+Vr8OsclBixEsSCeX+QfPO5FVt498n0Aw==`.

| Channel | Version | Status |
| --- | --- | --- |
| JavaScript archive | `@agenticdriver/sdk@0.2.0-alpha.4` | Published to npm through GitHub OIDC, byte-verified and installed. GitHub archive is identical; stable `latest` remains `0.1.0`. |
| crates.io | `agenticdriver = "=0.2.0-alpha.4"` | Published through GitHub OIDC on Prometheus; registry contents and fresh installation verified. |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.4` | Immutable module tag published; public-proxy installation verified. |
| Python | `agenticdriver==0.2.0a4` | GitHub wheel/sdist published and installed; PyPI organization approval pending. |
| Linux x64 desktop | `0.2.0-alpha.4` | Exact CI archive published; wide/narrow native checks passed on Prometheus and Fedora. |

[Rust publication 36347803499](https://github.com/agenticdriver/agenticdriver/actions/runs/36347803499) compared repackaged contents before obtaining its short-lived OIDC identity. [Go publication 36347805372](https://github.com/agenticdriver/agenticdriver/actions/runs/36347805372) verified the candidate before creating the immutable tag and testing the public proxy. Both passed on Prometheus runner 21. npm used the original CI archive through GitHub OIDC on a standard hosted runner; no registry credential was copied to Prometheus.

The [public download verification](../../release/0.2.0-alpha.4/github-publication.json)
and [desktop smoke receipt](../../release/0.2.0-alpha.4/desktop-verification.json)
record independently checked results. The selected PyPI organization's approval
remains pending; Python uses the GitHub wheel/sdist. No personal PyPI publisher
is introduced. npm has a dedicated public-repository hosted publish-only job; all
builds and tests remain on Prometheus.

The [earlier npm attempt receipt](../../release/0.2.0-alpha.4/npm-pending.json)
is historical: that member browser flow failed before upload. It was superseded
by [OIDC publication run 36354301760](https://github.com/agenticdriver/agenticdriver/actions/runs/36354301760).
The upload succeeded without a browser approval or stored npm token; its immediate
verification step failed while npm processed the package. Subsequent anonymous
registry metadata and tarball downloads matched the reviewed SHA-256/SHA-512.
The workflow now waits for processing without retrying the upload; authentication
errors and conflicting bytes still fail immediately.

[Verification run 36354464584](https://github.com/agenticdriver/agenticdriver/actions/runs/36354464584)
checked the existing identical package and skipped upload. The
[npm publication receipt](../../release/0.2.0-alpha.4/npm-publication.json)
records both runs and stable/alpha tags. Automatic npm provenance was disabled
for this delayed source revision, so it does not incorrectly attest alpha.4 to
the newer workflow commit. Future same-commit publication enables it. Account
security settings and existing credentials were preserved.

## Desktop and application adoption

The existing user-local application-menu launcher now selects `0.2.0-alpha.4-619c28a4dadc`. Previous runtimes remain installed. Active desktop sessions, shared regular/synthetic hosts, private state, credentials and grants were not restarted or changed.

The three application owners and website owner received immutable package
coordinates, hashes, source and CI evidence in their existing T3 threads. Their
own commits and application acceptance remain separate work; delivery of this
handoff is not proof of adoption.

Applications retain their existing authentication, backend-private credentials,
Usagestat identities, saved model choices and execution grants. An updated client
does not upgrade a running host. Shared-host upgrades need coordination around
active work. Synthetic-validation credentials remain synthetic-only. Account
model availability, host permissions, app enablement and live qualification remain
distinct. There is no model/account/billing fallback or default inference deadline
or inactivity timeout. Windows/macOS/Linux ARM desktop qualification, a public
relay, signed installers and automatic updating remain outside this release.
