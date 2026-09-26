# AgenticDriver desktop

The local companion manages providers, Usagestat usage snapshots, application
connections and local/remote hosts. The first preview is Linux x64. It uses the
same SDK provider component and backend contracts as TypeScript, Python, Go and
Rust applications.

This source preview is on `sdk-roadmap`; it is **not** included in registry SDK
0.1.0. There is no public desktop release or updater yet.

## Run from source

From the SDK repository root:

```sh
npm ci
npm run build
npm ci --prefix apps/desktop
npm run prepare:runtime --prefix apps/desktop
npm start --prefix apps/desktop
```

Preparation downloads Electron 44.4.5 and the official Node 24.21.0 Linux x64
runtime, with the Node archive checked against its pinned SHA256. The packaged
app includes both runtimes and does not require a system Node installation.
Native provider CLIs and Usagestat remain separately installed dependencies.

## Build and install locally

```sh
npm run package:linux --prefix apps/desktop
node apps/desktop/scripts/install-local.mjs apps/desktop/release/linux-unpacked
```

Launch **AgenticDriver** from the application menu. The installer uses
`~/.local/share/agenticdriver/desktop` and the user application-menu directory
(or `XDG_DATA_HOME`), retains previous preview versions, and does not install a
system service. The archive is
`apps/desktop/release/AgenticDriver-0.1.0-alpha.1-linux-x64.tar.gz`.
Extract it and launch `agenticdriver-desktop` for portable use. No sudo or
`--no-sandbox` option is needed on the qualified Fedora desktop. Distribution
policies for user namespaces still apply; do not disable the renderer sandbox.

Re-run the build/install commands to update a source preview. To remove it,
close the app and remove the generated `dev.agenticdriver.desktop` launcher and
its `agenticdriver/desktop` installation directory. Keep its private app-data
profile if you want to preserve saved settings and connections. Removal does not
revoke grants on remote hosts; revoke those there first when appropriate.

## Use it

1. The app starts a separate empty local host with a stable loopback endpoint.
   Add a provider in **Providers**, using an existing official native session,
   a write-only API key or an explicitly selected compatible gateway.
2. In **Connections**, name the application, review its provider access and
   lifetime, then create a one-use invitation. Paste it into the application's
   AgenticDriver connection settings. Grant provider management only when that
   application should administer the host.
3. **Hosts** can start/stop the desktop's host or pair with another host using
   its invitation. A management grant enables remote provider editing. Local
   invitations refer to this computer; remote access needs reachable HTTPS or
   an existing secure tunnel. The app does not establish a NAT relay or open
   firewall ports. Private CAs must be trusted by the bundled Node process
   (for example through explicitly configured `NODE_EXTRA_CA_CERTS`).
4. **Usage** reads the existing Usagestat service, initially
   `http://127.0.0.1:6736`. Change its URL and optional write-only service token
   in that screen. The supported native endpoints are `GET /v1/providers` and
   `GET /v1/usage`; quota progress, resets and costs come from the backend's
   metric records. Source, stale data and missing measurements remain visible.

Usagestat's existing ingestion setup continues to own SDK-run storage and
account/subject bindings; selecting a read endpoint here does not enable run
capture or create bindings. See [the SDK Usagestat guide](usagestat.md).
The app does not create a second accounting database or infer that a provider
quota belongs to a particular SDK account. Presentation names/colors reuse
Usagestat metadata where the configured provider ID matches; unbundled icons use
the SDK's fallback mark.

Models reported by an account stay visible. Catalog discovery, host permissions,
application enablement and live qualification remain separate. No inference is
performed by onboarding or metadata refresh. Native interactive sign-in inside
the app is tracked separately in [#50](https://github.com/agenticdriver/agenticdriver/issues/50);
this preview attaches existing official sessions and does not claim to implement
that flow. No provider/account/model fallback is added.

## Host lifecycle and private state

The app stores its own `driver` subdirectory under Electron's `userData` directory.
`settings.json` contains the selected host and stable local port. `local/config.json`
is the SDK-managed provider configuration; operator, provider and paired-client
credentials are separate private files. `connections/<id>/profile.json` uses the
normal SDK connection-profile contract. It never adopts or changes an existing
LitAgent, synthetic-validation or CLI host.

`AGENTICDRIVER_DESKTOP_DATA=/private/directory` selects a separate desktop profile
for development or testing. One desktop process owns a profile. A stale lock is
recovered only after its process no longer exists. An occupied saved host port
fails instead of attaching to another service or silently changing the endpoint.

Closing the app stops its local host. It asks before interrupting active paired
requests. Connection activity is process-local HTTP observation, including metadata
requests; it is not persistent online presence or usage accounting. Static
credentials are outside the pairing list. Refreshing metadata does not cancel runs.
Remote host removal forgets this app's saved credential without stopping that host.

The renderer is sandboxed, has context isolation and no Node integration. A narrow,
validated IPC interface reaches a separate Node worker; long-lived credentials
stay there. The renderer loads only packaged assets through a restricted local
protocol, and new windows/navigation are denied except selected documentation
links opened by the user. This is local transport access control; applications
retain their existing authentication stack.

## Validation

The [dated validation record](validation/desktop-2026-09-26.md) describes the
backend, native launch, portable artifact and visual checks for this preview.

```sh
npm test --prefix apps/desktop
npm run test:native --prefix apps/desktop
npm run test:usagestat --prefix apps/desktop -- /absolute/path/to/usagestatd
node apps/desktop/scripts/native-smoke.mjs /absolute/path/to/linux-unpacked/agenticdriver-desktop
```

Tests cover actual SDK hosts, private file permissions, durable endpoint/profile
restoration, remote management, grant rejection/revocation, write-only credentials,
metadata refresh during a streamed fixture run and protected shutdown. The native
smoke launches Electron and exercises renderer → IPC → Node → SDK management with
a synthetic provider, checking sandbox/context isolation and no renderer Node
API. The Usagestat check runs the real dependency in an isolated `--no-poll` profile.

Prometheus builds the Linux archive and launches it as a non-root user under Xvfb
in an offline container, with Electron's sandbox enabled. Windows, macOS, Linux
ARM, signed installers, automatic updates, relay hosting and native browser login
are not qualified by this preview.

For visual development, `npm run preview --prefix apps/desktop -- --fixtures`
starts an isolated HTTP preview with clearly synthetic usage and provider records.
It writes a private `launch.json`; use that URL in T3's collaborative browser.
This development bridge is not part of the shipped desktop runtime.
