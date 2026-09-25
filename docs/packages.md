# JavaScript package verification

The published package is `@agenticdriver/sdk@0.1.0`. Applications should pin that
registry version and keep their own lockfile:

```sh
npm install --save-exact @agenticdriver/sdk@0.1.0
```

See [release evidence](validation/release-0.1.0.md) for the published archive's
source and checksums. Development source can contain changes beyond the released
version; a local archive with the same version string is not the published
artifact and must not replace an existing registry release.

## Verify a development candidate

Use a separate clean checkout of the chosen commit:

```sh
npm ci
npm run check
npm run test:package -- --receipt /tmp/agenticdriver-package-receipt.json
```

`test:package` cleans generated `dist`, builds and packs twice, and requires
identical archive bytes under the recorded toolchain. It then installs that
archive into a fresh external application with lifecycle scripts disabled.
The check verifies:

- Every advertised ESM export and declaration resolves inside the installed
  artifact. A source symlink or private unexported entry point is rejected.
- A strict NodeNext TypeScript consumer compiles with `skipLibCheck: false`.
  Its compiler and Node types use the SDK lockfile's exact versions, and every
  compiler input stays inside that consumer.
- Selected-context authorization, immutable revisions, source filtering,
  SQLite persistence after reopen, traceable citations and draft artifacts work
  through the installed package. Denied requests fail before generation.
- Markdown ingestion retains its content digest, revision and section location
  after reopening SQLite. Catalog fixtures check account labels, missing quota
  information and approved synthetic provider assets.

The runner uses temporary empty npm configuration and a private cache. It passes
no provider credentials, account tokens, Node loaders or `NODE_PATH` to its child
processes. Network access installs public npm dependencies; model responses and
embeddings are deterministic local fixtures. It removes the consumer afterward.

The JSON receipt records the source commit and dirty flag, source and consumer
lockfile digests, archive digest, runtime/compiler versions and resolved exports.
A dirty receipt is development feedback; rerun after committing the candidate
to obtain evidence tied to a clean revision. Repeat-build equality applies to
the recorded environment, not to arbitrary toolchains or operating systems.

## Hand off the verified archive

To give an application the same development candidate, pack the unchanged
checkout and compare its SHA-256 to the receipt:

```sh
npm pack --pack-destination /tmp
sha256sum /tmp/agenticdriver-sdk-0.1.0.tgz
```

The filename follows the manifest version. Preserve the matching archive and
receipt together under their digest. An application can install those reviewed
bytes from its own artifact directory:

```sh
npm install --save-exact ./vendor/agenticdriver-sdk-0.1.0.tgz
```

Keep the archive available for later `npm ci` runs and retain the application's
lockfile. Remove aliases that redirect SDK imports to a sibling checkout. The
application must run its own acceptance checks; this package contract alone
does not establish integration, deployment or live provider certification.

Exports are discovered from the installed manifest so new public entries receive
the same resolution and declaration checks. `npm run test:install` additionally
checks installed examples, browser isolation and the host CLI lifecycle. Release
bundle and public-registry checks are described in [publishing](releases.md).
