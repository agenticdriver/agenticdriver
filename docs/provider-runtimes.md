# Managed provider runtimes

On supported Linux x64 hosts, **Add provider → Codex** offers **Install Codex
0.157.0**. Choose the execution host first: a remote installation happens on that
host. After verification, choose **Use for this connection** to select the installed
executable for the new connection. Then choose an existing sign-in or start the
separate [device sign-in](provider-sign-in.md). Installation never signs in,
configures a provider, runs a model or grants application execution access.

This is post-RC.2 source work on `sdk-roadmap`. Existing released RC.2 hosts omit
this feature and keep their manual-install flow. Other native runtimes and
platforms still use their official installation instructions.

The host pins the official OpenAI `rust-v0.157.0` Linux x64 musl archive and both
its archive/executable SHA-256 digests. It downloads over certificate-verified
HTTPS, accepts only the reviewed release redirect origins, checks the exact byte
count and hash before extraction, then checks the extracted executable hash and
`codex-cli 0.157.0` version. A private staging directory is renamed into place only
after verification. Failed or cancelled installs remove their staging files.
The normal CLI and shared account profiles are preserved. This SDK pin follows
the adapter's qualification; it is not a claim that 0.157.0 is the latest upstream
release. OpenAI's general installation route is documented in its
[Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli).

The host needs a working `tar` command and at least 600 MiB free. Runtime files
live beside its private configuration in
`provider-runtimes/codex-0.157.0-linux-x64/`. The executable is private to the host
user. AgenticDriver checks its integrity on restart and after filesystem metadata
changes. Paths returned by this API belong to the execution host and are not
browser asset URLs. No automatic update or deletion of an installed runtime is
provided by this feature.

## Management contract

Discover `provider-runtimes` in the authenticated protocol features. The feature
and `POST /v1/management/runtimes` require the separate `manageProviders` grant.
Execution access alone does not permit installation.

| Client                  | Operation                              |
| ----------------------- | -------------------------------------- |
| TypeScript / JavaScript | `client.providerRuntime(request)`      |
| Python sync / async     | `client.provider_runtime(request)`     |
| Go                      | `client.ProviderRuntime(ctx, request)` |
| Rust blocking / async   | `client.provider_runtime(&request)`    |

Each language provides `ProviderRuntimeRequest`, `ProviderRuntimeInfo` and
`ProviderRuntimeSnapshot` types. Requests are:

```json
{"action":"status","kind":"codex"}
{"action":"install","kind":"codex"}
{"action":"cancel","kind":"codex","id":"<installation UUID>"}
```

Callers cannot supply a release URL, version, shell command or installation path.
`install` acknowledges scheduling; poll `status` until `installed`, `failed` or
`cancelled`. Responses have `{ "version": 1, "runtimes": [...] }`, currently with
one Codex runtime. The phase can also be `missing`, `downloading` or `verifying`.
Progress contains `downloadBytes`, `totalBytes`, the expected `archiveSha256`, and
an optional attempt ID/update timestamp. Only `installed` has a `binary` path.
An installed executable may be reused explicitly by another new connection;
calling install again does not replace it.

`canCancel` is caller-specific. Cancellation belongs to the initiating credential,
bound to its authenticated principal and credential digest. Another management
connection can inspect shared runtime status but cannot cancel that attempt.
Transport disconnects do not cancel an acknowledged installation; explicit
cancellation or graceful host shutdown stops it. Model execution and its timeout
policy are unaffected.

The shared provider panel exposes progress, cancellation, retry and runtime
selection through `{ "action": "runtime", "request": ... }`. Metadata snapshots
only inspect status; they never start a download. In consuming applications,
mount the panel behind their existing settings authorization and CSRF checks.

## Recovery

`RUNTIME_DOWNLOAD_FAILED` permits an explicit retry after checking host network
access. Integrity failures publish no executable. A damaged existing runtime is
reported as `RUNTIME_DAMAGED`; inspect it with the host stopped before manually
moving that private installation aside. The app does not overwrite a damaged
runtime that might be referenced by provider settings.

Only one installer can hold the private `.install-lock`. Another installer gets
`RUNTIME_BUSY`. If an abrupt process or machine crash leaves a lock or staging
directory, stop the host, confirm no installer is running, and remove only that
runtime store's stale lock/staging directory before restarting. Automatic stale
lock takeover is deliberately absent. Graceful cancellation and shutdown remove
these files normally. A filesystem cleanup failure is reported as
`RUNTIME_CLEANUP_FAILED`; have the operator inspect the store with the host stopped
before retrying. Provider credentials and configuration are separate.

[Real local/Prometheus qualification](validation/managed-runtime-2026-09-30.md)
records installation, cancellation, restart, language-client checks and the
selected inexpensive model run. Catalog entries remain unqualified until tested.
