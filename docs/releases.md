# Release candidates and publication

**No SDK registry package has been published.** Candidate versions are 0.1.0,
with wire protocol 1.0. Development archives are installable through the
[quickstart](quickstart.md). The [changelog](../CHANGELOG.md) records behavior
and remaining live-provider limitations.

## Distribution inventory

The user selected organization ownership before the first upload. The source
repository is public at `agenticdriver/agenticdriver`; its issues and history
transferred from the personal account. npm uses **`@agenticdriver/sdk`**, while
PyPI and crates.io keep **`agenticdriver`**. `release/config.json` records the
selected owners, package names and bootstrap maintainer.

Read-only checks on 2026-09-21 found no published package at those coordinates.
This does not reserve a name or prove publishing permission. The npm CLI verified
`hashimkarim` as an owner of the `agenticdriver` npm organization. The GitHub
`agenticdriver:maintainers` team exists with that user as a maintainer. PyPI
organization/project setup and crates.io bootstrap authentication are pending.

| Channel   | Candidate identity                                  | Version source                  | Current state                                               |
| --------- | --------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| npm       | `@agenticdriver/sdk`                                | Root `package.json`             | Organization access verified; first upload pending          |
| PyPI      | `agenticdriver`                                     | `clients/python/pyproject.toml` | Organization/project publisher setup pending                |
| crates.io | `agenticdriver`                                     | `clients/rust/Cargo.toml`       | GitHub team prepared; bootstrap and crate ownership pending |
| Go        | `github.com/agenticdriver/agenticdriver/clients/go` | `release/config.json`           | Public source available; no version tag published           |

These channels match the SDK's language packages. Node also supplies the host
CLI; Python and Rust are libraries, not `pipx`/`cargo install` apps. OS package
managers, desktop stores, a public container registry and the docs domain are
separate distribution choices. This work does not create those destinations.

## Organization ownership

npm's `@agenticdriver` scope belongs to its organization. The publishing human
remains `hashimkarim`, an organization owner; no shared organization password is
needed. Existing development imports from `agenticdriver` must change to
`@agenticdriver/sdk`, including subpaths such as `@agenticdriver/sdk/client`.
The executable remains `agenticdriver`.
[npm organization packages](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)

PyPI organizations are separate from GitHub organizations. Create/select the
approved `agenticdriver` PyPI organization, create its `agenticdriver` project,
and bind that project's trusted publisher. Do not create a personal pending
publisher as a substitute for the selected organization owner.
[PyPI organization projects](https://docs.pypi.org/organization-accounts/actions/project-actions/)

crates.io uses GitHub teams as organization owners. Its first upload still needs
an individual member's token; immediately add `github:agenticdriver:maintainers`
as a crate owner and verify the team. Retain `hashimkarim` as the individual
administrator: team owners can publish and yank but cannot change owners.
[Cargo owners](https://doc.rust-lang.org/cargo/reference/publishing.html#cargo-owner)

The Go module is `github.com/agenticdriver/agenticdriver/clients/go`. Update
development imports and `go.mod` from the personal path before adopting 0.1.0.
No semantic-version tag was published under the personal path. Historical
pseudoversions remain historical artifacts, not aliases for the new module.

## Build and verify

Use a clean checkout of the intended commit, Node 24/npm, Python 3.12+, Go 1.22+
and Rust 1.89 through rustup. OpenSSL 3 is needed for the installation check:

```sh
npm ci
python3 scripts/release.py build --output /absolute/path/to/new-candidate
python3 scripts/release.py verify /absolute/path/to/new-candidate --require-clean
python3 scripts/test-release.py /absolute/path/to/new-candidate
```

The output directory must not exist. The builder copies only Git-tracked source
into an isolated tree, installs locked npm dependencies and pinned Python build
tools, and builds the npm tarball, Python wheel/sdist, Rust crate and Go module
proxy archive. `manifest.json` records the commit, versions, protocol, toolchains,
file sizes and SHA-256 digests. Preserve it and `SHA256SUMS` with the artifacts.
A checksum verifies integrity; it is not a signature or proof of trusted authorship.

Verification rejects mismatched versions/digests, missing/extra files, private
configuration filenames, links, traversal, duplicate members and oversized
archives. Installation runs three npm recipes plus the four language quickstarts
against the installed npm host through verified HTTPS. Python runs from wheel
and sdist; Go uses the packaged proxy without `replace`; Rust uses the extracted
crate. The checkout's dev dependencies are test tooling only. Model work is synthetic.

For tooling development, `build --allow-dirty` creates an explicitly dirty
candidate. `verify --require-clean` rejects it. New source inputs must be added
to Git's index to enter that development build. Do not publish a dirty candidate.

Build timestamps derive from the commit, and Python sdist tar/gzip metadata is
normalized. Dependency locks and pinned build tools support repeatable packaging
on the same toolchain. Cross-platform or changed-toolchain output is not assumed
byte-identical. The [candidate workflow](../.github/workflows/release-candidate.yml)
runs in CI or manually, retains the tested bundle for 14 days, and has read-only
repository permissions with no registry-upload step or publishing secrets.

## Prepare publication

AD-042 remains open until registry installation and all three app migrations
are verified. The selected release target is 0.1.0 under `agenticdriver`, with public
source and public packages. Authenticate the selected registry identities and
configure their publishing destinations before uploading the tested candidate.
Public Go installation uses the public module proxy and checksum database.
The npm CLI authenticated as the organization member `hashimkarim` on 2026-09-21.
PyPI and crates.io publishing access still needs verification; no credentials
live in this repo.

The current first-publication requirements differ:

- npm supports trusted publishing on GitHub-hosted runners with Node 22.14+
  and npm 11.5.1+. Bind repository, workflow, environment and allowed publishing
  action. A selected owner must bootstrap the first package; do not upload a
  placeholder to create settings. Automatic provenance also requires the public
  source repository and a supported trusted-publishing workflow.
  [npm guidance](https://docs.npmjs.com/trusted-publishers/)
- PyPI supports a pending publisher for a new personal project, but this release
  selects an organization-owned project. Create that project in the organization
  first, then bind its exact repository, workflow and environment. Use PyPA's
  action with job-scoped `id-token: write`.
  [New projects](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/),
  [publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/)
- crates.io requires an existing crate before trusted publishing. Its first
  upload needs a selected owner's scoped API token; later releases can exchange
  GitHub OIDC through `rust-lang/crates-io-auth-action`.
  [crates.io guidance](https://crates.io/docs/trusted-publishing)
- The Go package's 0.1.0 tag is `clients/go/v0.1.0`, because it lives below the
  repository root. Tags remain immutable; there is no registry-upload token.
  [Go publication](https://go.dev/doc/modules/publishing)

### Publisher bindings

The manual [publication workflow](../.github/workflows/publish.yml) accepts one
`registry` (`npm`, `python`, `rust` or `go`) and a `ci_run` ID. Run it on
`sdk-roadmap` at the **same commit** as the successful SDK checks run. It rejects
pull-request runs, unrelated workflows/repositories, failed/incomplete checks,
changed source revisions and mismatched candidate identities. It downloads and
verifies that run's exact candidate bundle; it does not rebuild npm or Python.
Artifacts expire after 14 days, so a missing bundle requires a fresh CI run.

Configure the registry-side trusted publishers with these exact values:

| Setting           | npm                              | PyPI                                   | crates.io                                                        |
| ----------------- | -------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Owner             | npm organization `agenticdriver` | PyPI organization `agenticdriver`      | `github:agenticdriver:maintainers` plus individual administrator |
| Package/project   | `@agenticdriver/sdk`             | `agenticdriver`                        | `agenticdriver`                                                  |
| GitHub owner      | `agenticdriver`                  | `agenticdriver`                        | `agenticdriver`                                                  |
| Repository        | `agenticdriver`                  | `agenticdriver`                        | `agenticdriver`                                                  |
| Workflow filename | `publish.yml`                    | `publish.yml`                          | `publish.yml`                                                    |
| Environment       | `npm`                            | `python`                               | `rust`                                                           |
| First upload      | Organization member login        | Organization project trusted publisher | Scoped member token, then team ownership                         |

npm's binding permits `npm publish`; staged publishing is not used. The Python
upload uses the pinned PyPA action and OIDC. Rust checks Cargo's repackaged files
against the candidate before acquiring its short-lived crates.io identity.
Only the Go job has `contents: write`, to create `clients/go/vX.Y.Z` at the
verified commit. It never updates an existing tag to a different commit, and
tests a fresh installation from the public Go proxy after tagging.

The npm and Rust initial uploads use the same `scripts/publish.py prepare` gate
and inspected CI bundle with the selected owner's native registry login. Never
use a first-upload placeholder. Bind trusted publishing once those packages
exist; the workflow has no fallback to another owner or stored registry token.
Publisher configuration and successful local login are not publication evidence.

Retries query the exact version before upload. A matching existing npm/crate
is verified and skipped. PyPI checks every existing file and uploads only missing
files; a conflicting digest or unexpected file stops the entire attempt. HTTP
401/403/429, redirects and outages are errors, not evidence that a version is
available. Every channel verifies its actual remote metadata after publication.

Use native registry authentication. Keep credentials out of source, artifacts
and command arguments; preserve other package owners/tokens. Hosted CI could not
start while the repository was private on 2026-09-21 because of an account
billing/spending restriction. The user subsequently authorized public visibility;
fresh CI must establish the current result. No billing or spending settings changed.

## Release and recover

After authorization and destination setup, verify the clean candidate and its
complete SDK CI result. Upload the inspected npm/Python files. Cargo repackages
during publication, so compare its package with the reviewed candidate before
uploading. Publish the reviewed Go subdirectory tag. Give publishing jobs only
their necessary registry identity; candidate builds need no OIDC permission.

Before retrying an upload, look up that exact version and reconcile remote
digests. A timeout, 401 or outage is not evidence of absence. Never overwrite a
tag, unpublish, yank or use `--skip-existing` to conceal a mismatch. Fix defects
in a new version with a changelog entry.

Install each exact registry version in a fresh app and run its synthetic workflow,
TLS and cancellation checks. Coordinate the three app agents to pin coordinates
and lockfiles, rerun integrations, then remove development archives/source aliases.
Current artifacts remain valid until migration is verified. [Migration notes](migrations.md)
cover protocol, auth and canonical data; language versions may advance independently
while retaining an explicitly compatible wire protocol.
