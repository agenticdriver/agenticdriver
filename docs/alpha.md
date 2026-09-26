# 0.2.0-alpha.2 application preview

This opt-in release packages the provider and connection component, refreshable
account model catalogs, remote provider management, local/remote pairing, owned
Codex device sign-in and the Linux desktop companion. Wire protocol stays **1.0**.
The shared component supports strict style CSP and capability-gated provider removal.
Alpha.2 fixes host-helper composition with TypeScript `exactOptionalPropertyTypes`
and exports `readConnectionProfile` for validated backend settings metadata.
The installed-package check compiles with strict optional-property semantics.
Check the [GitHub prerelease](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.2)
for the immutable source, publication status, tested archives and checksums.
The stable npm `latest` tag remains on `0.1.0`.

## Install the exact alpha

Once the corresponding channel is listed as published on the release page:

```sh
npm install --save-exact @agenticdriver/sdk@0.2.0-alpha.2
# The moving preview channel is @agenticdriver/sdk@alpha; applications pin exact versions.

go get github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-alpha.2
```

For Rust, use `agenticdriver = "=0.2.0-alpha.2"` in `Cargo.toml`.

The reviewed JavaScript archive is also available from the public release. This
works while npm member sign-in is pending:

```sh
npm install --save-exact https://github.com/agenticdriver/agenticdriver/releases/download/v0.2.0-alpha.2/agenticdriver-sdk-0.2.0-alpha.2.tgz
```

The package and import name remain `@agenticdriver/sdk`. Commit the public URL and
the lockfile integrity. The expected archive SHA-256 is
`a49dcc4c7d146d1f91fae58638d8b901f4ef6f51c873dd227070de54e4c2ebee`.
After registry publication, the exact semver pin resolves the same reviewed
archive. See the [publication evidence](validation/release-0.2.0-alpha.2.md).

Python uses the canonical PEP 440 version **0.2.0a2**. PyPI organization approval
is still pending; download `agenticdriver-0.2.0a2-py3-none-any.whl` from the
prerelease, verify its SHA-256 against the release manifest, and install it in
your virtual environment with `python -m pip install ./agenticdriver-0.2.0a2-py3-none-any.whl`.
Do not substitute an unrelated PyPI package or a personal publisher.

The Linux desktop archive is `AgenticDriver-0.2.0-alpha.2-linux-x64.tar.gz`.
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
   not upgrade a separately running host. Older protocol-1.0 hosts remain usable
   for their advertised features; unavailable controls must stay disabled.
4. Embed the [provider component](provider-panel.md) in the authorized settings
   screen. Import browser code from `@agenticdriver/sdk/ui`; keep the native
   backend bridge from `@agenticdriver/sdk/panel` and long-lived credentials on
   the server. Python, Go and Rust ship the same component with native bindings.
5. Test connection save/reload, catalog refresh, explicit selection, denied
   execution and backwards compatibility with synthetic fixtures. Keep catalog
   availability, host execution grants, application enablement and live-model
   qualification separate. Refresh must retain choices and leave runs running.

For a new local host, use the desktop's empty-host onboarding or the documented
`agenticdriver setup` / `agenticdriver panel` flow. A one-use invitation exchanges
for a private connection profile. Remote hosts need reachable HTTPS or an
existing secure tunnel; a browser's local machine and a hosted backend are
different environments. See [connection setup](connections.md).

Upgrade a shared host only after checking active work, preserving its config,
private credentials, Usagestat identities and durable state, and arranging a
graceful restart. New management features do not justify expanding an existing
app token's scope. Synthetic-validation credentials remain synthetic-only.

## Qualification and compatibility limits

Package verification exercises all four installed clients over verified HTTPS,
the shared component and offline native-provider fixtures on Prometheus. These
checks do not certify every discovered model, all native versions, new accounts,
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
