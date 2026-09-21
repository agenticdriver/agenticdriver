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

The [GitHub 0.1.0 release](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.1.0)
contains the preserved candidate bundle plus individual npm, Python and Rust
archives. All eight uploaded asset digests matched the reviewed files before
publication. `ASSET-SHA256SUMS` covers the flattened release assets; the bundled
`SHA256SUMS` retains the original artifact paths.

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

## Application migration evidence

The owning application threads migrated their own dependencies and independently
checked the npm archive hashes. Source commits and remote branch heads were
verified after their pushes. All three pin `@agenticdriver/sdk` exactly to 0.1.0.

| Application | Pushed commit and branch | Reported application checks |
| --- | --- | --- |
| AI Workspace | `743e5df3e055fc83a4c44e59a097be5a4a2a0f89`, `main` | Clean install, five adapter tests, synthetic demo, 66 app tests, typechecks and both builds; default checks also pass with the optional SDK absent |
| Brandstorm | `29a0b72bffc6ef05790b7f33999877ebeaa3ae80`, `agenticdriver-connection-setup` | Frozen pnpm install, 94 unit tests, provider-management browser fixture, lint, typecheck and all 26 build tasks |
| LitAgent | `c21b14c7a5bfcd62a82d0094085a517599ac0575`, `chat-reliability` | Fresh frozen Bun install, typecheck, 117 tests, workspace build and two desktop-width chat fixtures |

Each migrated application resolves the installed registry package without an
SDK sibling checkout. The Brandstorm integration branch is not merged into its
original dirty checkout. LitAgent's separate unmerged AD-035 fixture branch still
has its historical archive and must retain the registry pin when integrated.
These branch boundaries are not deployment or live-provider acceptance.

## Remaining AD-042 work

- Wait for the PyPI `agenticdriver` organization approval, then create its project
  and trusted publisher with environment `python`. Publish and verify these
  exact Python artifacts.
- Preserve the verified app registry pins when their independently developed
  branches are integrated; do not reinstate earlier source aliases or archives.
- Preserve the published source and artifacts when later SDK changes are made;
  changed package contents require a new version.

Native-provider qualification and live application checks remain separate open
roadmap work. No paid model request was made during these release checks.
