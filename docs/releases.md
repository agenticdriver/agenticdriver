# Release candidates and publication

**No SDK registry package has been published.** Candidate versions are 0.1.0,
with wire protocol 1.0. Development archives are installable through the
[quickstart](quickstart.md). The [changelog](../CHANGELOG.md) records behavior
and remaining live-provider limitations.

## Distribution inventory

Read-only checks on 2026-09-21 returned HTTP 404 for `agenticdriver` on npm,
PyPI and crates.io. No public package was found; this does not reserve a name,
establish ownership or verify publishing permission. The source repository
remains private on the personal GitHub account.

| Channel   | Candidate identity                                | Version source                  | Current state                                                 |
| --------- | ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| npm       | `agenticdriver`                                   | Root `package.json`             | Tarball built; registry owner/bootstrap not selected          |
| PyPI      | `agenticdriver`                                   | `clients/python/pyproject.toml` | Wheel and sdist built; account/pending publisher not selected |
| crates.io | `agenticdriver`                                   | `clients/rust/Cargo.toml`       | Crate built; owner/bootstrap not selected                     |
| Go        | `github.com/hashimkarim/agenticdriver/clients/go` | `release/config.json`           | Private pushed revisions work; no version tag published       |

These channels match the SDK's language packages. Node also supplies the host
CLI; Python and Rust are libraries, not `pipx`/`cargo install` apps. OS package
managers, desktop stores, a public container registry and the docs domain are
separate distribution choices. This work does not create those destinations.

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
are verified. First select registry owners, exact names, a release version and
public/private distribution. A public Python or Rust package exposes its packaged
source even when GitHub stays private. Public Go proxy installation requires
publicly reachable module source; authorized private Git access remains valid.

The current first-publication requirements differ:

- npm supports trusted publishing on GitHub-hosted runners with Node 22.14+
  and npm 11.5.1+. Bind repository, workflow, environment and allowed publishing
  action. A selected owner must bootstrap the first package; do not upload a
  placeholder to create settings. This private repository cannot produce npm's
  automatic provenance. [npm guidance](https://docs.npmjs.com/trusted-publishers/)
- PyPI supports a pending publisher for a new project. Bind the exact repository,
  workflow and environment, then use PyPA's action with job-scoped `id-token: write`.
  Pending publishers do not reserve names.
  [New projects](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/),
  [publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/)
- crates.io requires an existing crate before trusted publishing. Its first
  upload needs a selected owner's scoped API token; later releases can exchange
  GitHub OIDC through `rust-lang/crates-io-auth-action`.
  [crates.io guidance](https://crates.io/docs/trusted-publishing)
- The Go package's 0.1.0 tag is `clients/go/v0.1.0`, because it lives below the
  repository root. Tags remain immutable; there is no registry-upload token.
  [Go publication](https://go.dev/doc/modules/publishing)

Use native registry authentication. Keep credentials out of source, artifacts
and command arguments; preserve other package owners/tokens. Hosted CI could not
start on 2026-09-21 because of an account billing/spending restriction. No billing,
spending or visibility settings were changed.

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
