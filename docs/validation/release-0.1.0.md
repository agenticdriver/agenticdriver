# 0.1.0 publication evidence

Verified on 2026-09-21. This is the initial SDK foundation release with protocol
1.0; it does not certify a live provider account, production workload or the
remaining v1 roadmap gates.

## Immutable source and artifacts

- Source: `442ca9c627717f0cdb42ad8260a9692357c79a87` in
  [agenticdriver/agenticdriver](https://github.com/agenticdriver/agenticdriver/commit/442ca9c627717f0cdb42ad8260a9692357c79a87).
- [SDK CI 35612779939](https://github.com/agenticdriver/agenticdriver/actions/runs/35612779939):
  all eight jobs passed, including three Linux runtime combinations, macOS arm64,
  Windows, containers with verified TLS, documentation, and exact release archives.
- [Manifest](../../release/0.1.0/manifest.json) and
  [SHA-256 checksums](../../release/0.1.0/SHA256SUMS) preserve the CI bundle's
  source, toolchains and eight artifact digests. These are integrity records,
  not signatures.
- The npm and Rust registry archives have exactly the CI bundle's SHA-256 hashes.
  Cargo's repackaged archive was compared before upload and also matched byte for
  byte. Existing versions and Go tags were not replaced.

## Published packages

| Language | Exact dependency | Verified ownership or source |
| --- | --- | --- |
| JavaScript / TypeScript | `@agenticdriver/sdk@0.1.0` | npm organization `agenticdriver`; team `agenticdriver:developers` has write access |
| Rust | `agenticdriver = "=0.1.0"` | `github:agenticdriver:maintainers` and individual administrator `hashimkarim` |
| Go | `github.com/agenticdriver/agenticdriver/clients/go@v0.1.0` | Immutable `clients/go/v0.1.0` tag at the reviewed source |
| Python | Reviewed 0.1.0 wheel and sdist | PyPI organization approval pending; no registry upload |

The npm archive integrity is
`sha512-GuJ+fENsGqF82jPs5/nlnA413/l8y06OiZpd7v1Y2AGI/qa7j3pZFtnhIVUGEooG/IdPzMvdY7nIi7QU594lPA==`.
The Rust archive checksum is
`a5a7be996fa57eb86e1527f2a59572d61804358aa9ddde96466dfc89abfb0469`.

Install the published versions with:

```sh
npm install --save-exact @agenticdriver/sdk@0.1.0
go get github.com/agenticdriver/agenticdriver/clients/go@v0.1.0
cargo add agenticdriver@=0.1.0
```

These commands belong in the appropriate language's application directory.
The CLI executable remains `agenticdriver`. Python can use the reviewed wheel
or sdist while its selected organization is awaiting approval; do not substitute
a personal pending publisher.

## Installation and publisher checks

`scripts/test-release.py BUNDLE --registry npm --registry rust --registry go`
verified public registry metadata against the bundle, installed the exact versions
in fresh applications, and checked that Node resolved the public npm package,
Cargo resolved a registry dependency, and Go used its public proxy and checksum
database without `replace`. All four language quickstarts returned the expected
synthetic response over verified HTTPS. Python passed from both the reviewed
wheel and sdist. The three installed JavaScript application recipes also passed.

[Go publication run 35613669373](https://github.com/agenticdriver/agenticdriver/actions/runs/35613669373)
created the tag only after verifying the successful CI run and exact candidate.
Fresh public-module checks passed over HTTP and verified HTTPS, including
discovery, typed events, ingestion, provenance, error handling and cancellation.

npm and crates.io trusted-publisher configurations were created and read back:
GitHub owner `agenticdriver`, repository `agenticdriver`, workflow `publish.yml`,
environments `npm` and `rust` respectively. Native member credentials performed
these first uploads. Configuration verification is not proof of a subsequent
OIDC upload. npm reports both direct and staged publication permissions despite
the CLI request for direct publication only; the workflow uses `npm publish`.

## Remaining AD-042 work

- Wait for the PyPI `agenticdriver` organization approval, then create its project
  and trusted publisher with environment `python`. Publish and verify these
  exact Python artifacts.
- Have Brandstorm, LitAgent and AI Workspace pin the published package, regenerate
  their lockfiles, remove SDK source aliases, and pass their own fixture checks.
  SDK examples are not substitutes for application migration evidence.
- Preserve the published source and artifacts when later SDK changes are made;
  changed package contents require a new version.

Native-provider qualification and live application checks remain separate open
roadmap work. No paid model request was made during these release checks.
