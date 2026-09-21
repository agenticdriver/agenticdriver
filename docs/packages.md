# TypeScript package contract

The SDK has not been published to npm. Until registry releases are available,
install a built archive produced from a pinned source commit. A directory
dependency such as `file:../agenticdriver` can follow changes in that checkout;
an archive dependency records the chosen package bytes in the consumer lockfile.

## Build and verify a candidate

Use a separate checkout at the chosen commit, with no uncommitted changes:

```bash
npm ci
npm run check
npm run test:package -- --receipt /tmp/agenticdriver-package-receipt.json
npm pack --pack-destination /tmp
sha256sum /tmp/agenticdriver-0.1.0.tgz
```

Compare the final archive SHA-256 with `artifact.sha256` in the receipt before
handing it to an application. Store the archive and receipt together, preferably
under the digest. The filename and package version alone do not identify a local
candidate: multiple commits can still have version `0.1.0`.

`test:package` removes generated `dist`, rebuilds and packs twice, and requires
byte-identical archives under the recorded environment. It creates a temporary
external project, installs the archive with lifecycle scripts disabled, then:

- Imports every advertised ESM export and resolves it inside the installed
  package, rejecting a source symlink or a private unexported entry point.
- Compiles a TypeScript consumer against every advertised declaration using
  strict NodeNext settings and `skipLibCheck: false`. Its compiler and Node types
  have the exact versions from the SDK lockfile; every compiler input must be
  inside the external project.
- Runs synthetic selected context and retrieval through the installed package,
  including subject authorization, explicit source filtering, immutable source
  revisions, SQLite persistence after reopen, citation locations and draft-only
  output artifacts. Unauthorized requests must fail before provider execution.
- Ingests authorized Markdown through the installed ingestion entry point and
  verifies that its revision, section citation and content digest survive reopening
  the SQLite store. It also exercises catalog account labels, missing-quota
  presentation and approved synthetic provider assets with immutable URLs.

The runner uses its own empty npm configuration and cache. It passes no account
tokens, provider credentials, Node loaders or `NODE_PATH` to child processes. The
only network dependency is installing public npm packages; generation and
embeddings use deterministic local adapters. The external project is removed
after the check. The JSON receipt is printed and can also be saved with
`--receipt`; it records the source commit and dirty flag, source/consumer lockfile
digests, archive digest, runtime/compiler versions and resolved export paths.

A dirty receipt is development feedback, not proof of a committed release.
Repeat the check after committing a candidate. Repeat-build equality applies to
the recorded toolchain; it does not claim cross-platform reproducibility or
registry publication. A fresh consumer lockfile records the runtime dependencies
resolved during installation because the SDK's development lockfile is not
distributed with the package.

## Install the same bytes in an application

Copy the verified archive into an app-owned artifact directory, or retrieve it
from the artifact store by digest. Verify its SHA-256, then install it:

```bash
npm install --save-exact ./vendor/agenticdriver-0.1.0.tgz
```

Keep the archive available to subsequent `npm ci` runs and retain the consumer
lockfile. Each application's checks must resolve `agenticdriver` from its own
installed archive. Remove test aliases or path mappings that redirect SDK imports
to a sibling source tree or its `dist`. Run the application's actual acceptance
checks against this candidate; this package test alone does not establish app
integration or deployment.

Supported ESM entry points are `agenticdriver`, `/client`, `/server`, `/host`,
`/providers`, `/usagestat`, `/catalog`, `/provider-assets`, `/context`, `/retrieval`,
and `/ingestion`. Each supplies its own TypeScript declarations. The contract
discovers exports from the installed manifest so future entries receive the same
resolution and declaration checks. It checks a Node.js consumer; `npm run
test:install` also covers installed JavaScript and TypeScript examples, browser
bundling and the host CLI lifecycle. Other language package releases and
publishing automation remain separate AD-042 work.
