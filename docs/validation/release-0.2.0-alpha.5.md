# 0.2.0-alpha.5 publication evidence

Published on 2026-09-28 under [#64](https://github.com/agenticdriver/agenticdriver/issues/64).
The immutable source is
[`2d4d7c22c74e0a1dbd355398ee39f589ed4fbb76`](https://github.com/agenticdriver/agenticdriver/commit/2d4d7c22c74e0a1dbd355398ee39f589ed4fbb76).
Wire protocol stays **1.0**; stable npm `latest` stays **0.1.0**.

## Shipped changes

The Linux desktop manages named outbound OpenSSH routes with explicit save/edit,
start/stop, status and recovery messages. A running route can supply an invitation
address for the application server's loopback forward. Same-port restart preserves
paired grants. The desktop owns its SSH processes and guards interruption of
active requests. Native SSH identity and host trust remain outside the renderer.
The selected server is a trusted encryption endpoint and must honor loopback
binds. No auto-reconnect, alternate-port fallback or hosted relay is introduced.

Native CLI process cleanup reaps the POSIX group when the parent exits, so a child
holding stdout/stderr cannot keep an otherwise completed invocation open. Buffered
output and exit classification are preserved; callback failures reject after
cleanup. This does not contain hostile descendants that escape their group or
qualify Windows process trees. [Cleanup contract](../native-tools.md)

The source checkout includes 76 deterministic brand, literature and email
evaluations over local and authenticated HTTP execution with a reopened SQLite
vector store. Transport and quality/evidence/action judgments remain separate.
These are synthetic contract checks, not certification of real model quality or
the three applications. [Evaluation guide](../evaluations.md)

## Exact-source checks

All nine [Prometheus jobs](https://github.com/agenticdriver/agenticdriver/actions/runs/36428692136)
passed on `prometheus-agenticdriver-01`, runner 21. They cover packaged native
desktop/OpenSSH checks, pinned offline Codex and Claude contracts, containers and
verified TLS, Node 22.13.0/24.21.0/26.10.0 with the four clients, documentation,
and fresh installations of the exact candidate artifacts. The
[CI receipt](../../release/0.2.0-alpha.5/ci-receipt.json) records job identities.

Local SDK checks passed 351 tests, including five native-process regression
groups. All 16 desktop tests passed. The exact CI desktop archive also passed
Fedora native checks at 1340×883 and 390×844, with renderer isolation, strict
style policy and bundled Node 24.21.0. Its managed-SSH controller and compiled
process-cleanup implementation matched the reviewed source.

Real OpenSSH fixtures cover one-use pairing, replay rejection, revocation,
same-port restart, changed/unknown host keys, denied authentication/forwarding,
port collisions, ambient-forward suppression and worker-loss cleanup. A separate
two-machine test used the existing Prometheus SSH destination to reach a
mock-only local host from Python, verified the remote loopback bind and cleaned
up the temporary grant/tunnel/profile. The [SSH validation](desktop-ssh-2026-09-28.md)
also records wide T3 interaction and native narrow checks, including the specific
T3 narrow screenshot limitation.

Each of the three runtime rows passed all 76 expected evaluation outcomes with
zero live model calls; [evaluation receipts](../../release/0.2.0-alpha.5/evaluation-verification.json)
and the complete reports are preserved beside the manifest. All release testing
used synthetic/offline content. No real application payload or new account/model
selection was used. The earlier CI run `36427497038` was cancelled before upload
to incorporate [process cleanup #65](https://github.com/agenticdriver/agenticdriver/issues/65).

## Publication and installation

| Channel | Version | Verification |
| --- | --- | --- |
| npm | `@agenticdriver/sdk@0.2.0-alpha.5` | OIDC upload, exact bytes, fresh installation and signatures/provenance passed. |
| crates.io | `agenticdriver = "=0.2.0-alpha.5"` | OIDC upload, reviewed repackaging and fresh registry installation passed. |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.5` | Immutable source tag and public-proxy installation passed. |
| Python | `agenticdriver==0.2.0a5` | GitHub wheel/sdist installed; PyPI organization approval still pending. |
| Linux x64 desktop | `0.2.0-alpha.5` | Exact CI archive, public download and wide/narrow native checks passed. |

Publication runs: [npm 36431377901](https://github.com/agenticdriver/agenticdriver/actions/runs/36431377901),
[Rust 36431388297](https://github.com/agenticdriver/agenticdriver/actions/runs/36431388297),
[Go 36431397762](https://github.com/agenticdriver/agenticdriver/actions/runs/36431397762).
npm uses a standard public-repository hosted publish-only job because its OIDC
publisher requires that runner type. Builds/tests and Rust/Go publication remain
on Prometheus. No member browser approval or registry-token fallback was needed.

The npm attestation binds the exact archive SHA-512 to this source and
`.github/workflows/publish.yml`. A separate fresh `npm audit signatures` passed
seven registry signatures and two package attestations. The
[npm receipt](../../release/0.2.0-alpha.5/npm-publication.json) records the binding,
audit and unchanged stable tag; alpha now selects `0.2.0-alpha.5`.

Fresh npm, crates.io and public Go-proxy clients plus the reviewed Python wheel
and sdist completed the quickstart over certificate-verified HTTPS. All three
bundled JavaScript app examples passed. [Installed verification](../../release/0.2.0-alpha.5/fresh-installed-verification.json)

All nine [public prerelease assets](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.5)
were downloaded anonymously and matched their reviewed size/SHA-256. Release
and Go tags point directly to the source above. The original
[manifest](../../release/0.2.0-alpha.5/manifest.json),
[candidate hashes](../../release/0.2.0-alpha.5/SHA256SUMS),
[download hashes](../../release/0.2.0-alpha.5/ASSET-SHA256SUMS) and
[public download receipt](../../release/0.2.0-alpha.5/github-publication.json)
remain available. Checksums provide integrity records, not signatures.

| Artifact | SHA-256 |
| --- | --- |
| npm archive | `f8fbe71aaeb515aed1f082e8c463fbb23bd62ac6fca23133415bb1962902d9dd` |
| Rust crate | `02627da5bd5a3ac44c51941791b3a11167e06c4290a7413b16a5e5a65fe2bd25` |
| Python wheel | `683550ca432d88d011087d885e633ca089590635561a133bd3702f3e744f4677` |
| Python source | `4e1cfb1bf18b79ceb03796968be034298470f1b532677a7328f68ca1dac34806` |
| Linux desktop | `a51d41580c0e07569e9395aa8ae41ea3bb55042de5849e2776986c213606eb89` |

## Adoption boundaries

The user-local application-menu launcher selects `0.2.0-alpha.5-0eb5e08c2d47`.
Previous installations and active processes are preserved; reopening the desktop
uses the new version. Shared hosts, private state and app grants were not changed.

Application and website handoffs carry immutable package coordinates. Each owner
still performs their own acceptance; an SDK fixture or delivered message does
not prove adoption. Apps preserve their authentication, private credentials,
Usagestat identities, selections and enablement. Catalog availability, host
permission and live qualification remain separate. An SDK update does not
upgrade an already-running host or expand its authority.

The subsequent source-only operational soak work under #66 is **not** part of
this immutable candidate. Its runtime/memory qualification is separate evidence.
There is no default inference deadline or inactivity timeout. PyPI publication,
Windows/macOS/ARM desktop qualification, signed installers and automatic updates
remain outside this release.
