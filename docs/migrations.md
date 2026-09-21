# Versioning and migration notes

Current packages are `0.1.0` development artifacts with wire protocol `1.0`.
Registry publication is still pending. Preserve each artifact's source commit and
checksum; the same development version number alone cannot identify its contents.
The host and language packages may receive independent package versions while
retaining an explicitly compatible protocol.

Before changing a host or client, call `protocol()`, require the features your
workflow uses, and check the [compatibility matrix](compatibility.md). Unknown
required events or incompatible major wire versions must fail clearly.
[Protocol rules](protocol.md) define optional-event negotiation and stable errors.

## Organization package names before 0.1.0

The SDK repository is now `agenticdriver/agenticdriver`. JavaScript applications
adopt the npm package `@agenticdriver/sdk`, replacing development imports from
`agenticdriver` and its subpaths. The CLI command remains `agenticdriver`.
Go applications adopt `github.com/agenticdriver/agenticdriver/clients/go` in both
their imports and `go.mod`. Python and Rust retain the name `agenticdriver`.

No registry package or semantic-version Go tag was published under the earlier
personal ownership plan. Existing development archives should remain pinned
until each app verifies the new published package, imports, lockfile and workflow.
The wire protocol remains 1.0. See [release ownership and readiness](releases.md).

## From sibling source dependencies

Build or obtain reviewed npm/wheel/module/crate artifacts, install them in the
application, and retain its lockfile. The [quickstart](quickstart.md) shows all four
languages. Do not use a checkout-relative TypeScript alias, Python import path or
Go `replace` directive as a deployment dependency. A Rust path to the extracted
crate in an application's vendored artifacts is distinct from a sibling checkout.
Move to registry coordinates only after the deliberate package release and
installation checks have completed.

## From static driver credentials

Keep the application's canonical user, organization and service IDs. Integrate
its existing Better Auth database with AuthYard and the native OAuth provider.
Map current device/user or service grants to the SDK scopes; do not build a new
SDK identity database or silently turn an OAuth service client's owner into a
human subject. Follow [authentication](authentication.md) for consent, private
storage, rotation, introspection, resource audience and revocation behavior.

Programmatic `configuredServer` can omit `tokens` when an application supplies
`HostAuthentication`; mixed or absent authentication fails closed. The existing
static CLI still requires its configured development/operator token. The stock
container recipe uses explicit Better Auth service clients.

## Preserve execution and data contracts

- Keep stable Usagestat `hostId`, provider instance and `accountId` bindings.
  Accounting depends on these identities; model names are not account identities.
- Preserve canonical source IDs and revisions when changing parsing, chunking or
  embeddings. Use revision checks and atomic replacement; revalidate ownership
  when evidence is read.
- Require current durable-job authorization through a deliberate resolver.
  Expired request tokens cannot become indefinite worker credentials.
- Keep application approvals and accepted artifacts in the application.
  Validate returned citation IDs against actual selected evidence before saving.
- Cancel/drain a host deliberately before upgrades, back up its compatible state,
  and verify idempotent replay after restart. Never retry an uncertain side effect
  solely because the network connection was lost.

Better Auth/AuthYard have their own compatibility matrix and database migrations.
The SDK's tested auth fixture pins Better Auth/OAuth 1.7.3 and the AuthYard
`@authplane/better-auth` 0.2.0 connector on Node 24+. Qualify the renamed
`@authyard/better-auth` artifact and control-plane version before adopting it;
do not infer compatibility from a package rename.
