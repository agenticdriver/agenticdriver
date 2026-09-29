# 0.2.0-alpha.6 application preview

Alpha.6 removes mock providers, fake connections, the fake embedding adapter,
canned example outputs and simulated provider acceptance harnesses. New desktop
profiles start empty. CLI setup requires an explicit provider. Existing real
accounts, catalog discovery, provider management, local/remote pairing and the
Linux desktop remain supported. Wire protocol stays **1.0**, but management hosts
and clients require the coordinated upgrade described below.

The [shared provider icons](provider-icons.md), monochrome/colour and product-mark
choices, reported CLI/account details, SSH routes and native process cleanup
remain included. Account email/name stays masked until Reveal and is remasked on
refresh or provider changes. Catalog availability, execution grants and successful
model execution remain separate.

Alpha.6 is published on npm, crates.io, Go and GitHub. The
[publication record](validation/release-0.2.0-alpha.6.md) records exact artifacts
and real connection checks. The [release page](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.6)
is the authority for published channels, immutable source and exact artifact
checksums. npm publication uses GitHub OIDC trusted publishing. PyPI organization
approval remains pending; Python uses the reviewed GitHub wheel/sdist. Stable npm
`latest` remains `0.1.0`. Earlier releases and their historical evidence remain
available; they do not establish current real-provider qualification.

## Install the exact alpha

After confirming channel availability on the release page, pin the exact version:

```sh
npm install --save-exact @agenticdriver/sdk@0.2.0-alpha.6
go get github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.6
```

For Rust, use `agenticdriver = "=0.2.0-alpha.6"` in `Cargo.toml`.
Commit the version pin and lockfile integrity. Verify downloaded archives against
`manifest.json` and `ASSET-SHA256SUMS` on the release page.

Python uses **0.2.0a6**. Download `agenticdriver-0.2.0a6-py3-none-any.whl` from the
prerelease, verify its checksum, and install it in your virtual environment with
`python -m pip install ./agenticdriver-0.2.0a6-py3-none-any.whl`.
Do not substitute an unrelated PyPI package or a personal publisher.

The Linux desktop archive is `AgenticDriver-0.2.0-alpha.6-linux-x64.tar.gz`.
Extract it and run `agenticdriver-desktop`; Node and Electron are bundled.
See [desktop setup](desktop.md) for private state, local installation and updating.
There is no automatic updater, public relay, or Windows/macOS build in this alpha.

## Adopt in an existing application

1. Pin the exact registry package or public release archive and commit its lockfile. Replace sibling SDK links
   and unscoped development imports with `@agenticdriver/sdk` and its subpaths.
2. Keep the application's existing authentication, private credential storage,
   host URL, provider grants and saved model choices. No application auth
   migration, provider-account sign-in or new model call is required by this update.
3. Check `client.protocol()` before enabling a feature. An updated client does
   not upgrade a separately running host. Upgrade the host before alpha.6 management clients: old hosts advertise the
   removed `fixture` definition category. See [migration notes](migrations.md).
   Protocol 1.0 alone does not guarantee management compatibility.
4. Embed the [provider component](provider-panel.md) in the authorized settings
   screen. Import browser code from `@agenticdriver/sdk/ui`; keep the native
   backend bridge from `@agenticdriver/sdk/panel` and long-lived credentials on
   the server. Python, Go and Rust ship the same component with native bindings.
5. Test connection save/reload, catalog refresh, explicit selection, denied
   execution and backwards compatibility with real selected connections. Keep catalog
   availability, host execution grants, application enablement and live-model
   qualification separate. Refresh must retain choices and leave runs running. Test an
   unreachable saved host and explicit retry through the real settings/backend
   bridge: hide stale controls, retain the saved host/preferences and restore
   fresh state on recovery. A host-free state should still show app-permitted setup.
6. Treat `ProviderInfo.connection` as optional. Older hosts can omit it; absent
   CLI/account fields are unreported. Use the shared component's reveal control
   or keep identity masked in application-owned settings. Icon preferences are
   local presentation choices, independent of provider execution and billing.

For a new local host, use the desktop's empty-host onboarding or the documented
`agenticdriver setup` / `agenticdriver panel` flow. A one-use invitation exchanges
for a private connection profile. Remote hosts need reachable HTTPS or a
secure tunnel; the Linux desktop can explicitly manage an outbound SSH route
to an already trusted application server. In either case, a browser's local machine and a hosted backend are
different environments. See [connection setup](connections.md).

Upgrade a shared host only after checking active work, preserving its config,
private credentials, Usagestat identities and durable state, and arranging a
graceful restart. New management features do not justify expanding an existing
app token's scope. Do not reuse historical validation credentials as production application grants.

## Qualification and compatibility limits

Package verification installs and compiles all four clients and checks their
shared component on Prometheus. Real inference is a separate explicit check;
[alpha.6 evidence](validation/real-providers-alpha6-2026-09-28.md) records the actual
Codex/Luna and Claude/Haiku requests. These checks do not certify every discovered
model, all native versions, new accounts,
or complete application workflows. Keep the qualified Codex/Claude versions and
deployment limits in [compatibility](compatibility.md) and [native tools](native-tools.md).
Provider setup does not install native binaries. There is no model, account or
billing fallback and no default inference deadline or inactivity timeout.

Usage and provider metadata continue to come from the existing **Usagestat**
backend. Optional diagnostics are separate from accounting. The desktop's usage
screen reads its configured backend; it does not create another usage database.

## Release channel checks

`release/config.json` selects `alpha`. Release tooling accepts canonical
`X.Y.Z-alpha.N`, `-beta.N`, `-rc.N` or stable versions, with positive preview
numbers; Python uses `aN`, `bN` or `rcN`. It rejects mixed channels, malformed
versions and an npm publication tag that would promote an alpha to `latest`.
The reviewed manifest records the channel as well as each language's version.
Old stable manifests without a channel field retain their stable interpretation.

These conventions follow [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages),
[Python version specifiers](https://packaging.python.org/en/latest/specifications/version-specifiers/)
and [Go module release versioning](https://go.dev/doc/modules/release-workflow).
