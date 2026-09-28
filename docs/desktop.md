# AgenticDriver desktop

The local companion manages providers, Usagestat usage snapshots, application
connections and local/remote hosts. The first preview is Linux x64. It uses the
same SDK provider component and backend contracts as TypeScript, Python, Go and
Rust applications.

The desktop is packaged with the [0.2.0 alpha](alpha.md). Its Linux archive and
checksums are listed on the corresponding GitHub prerelease; the npm package is
the SDK/host CLI, not a desktop installer. There is no automatic updater yet.

## Run from source

From the SDK repository root:

```sh
npm ci
npm run build
npm ci --install-links --prefix apps/desktop
npm run prepare:runtime --prefix apps/desktop
npm start --prefix apps/desktop
```

Preparation downloads Electron 44.4.5 and the official Node 24.21.0 Linux x64
runtime, with the Node archive checked against its pinned SHA256. The packaged
app includes both runtimes and does not require a system Node installation.
Native provider CLIs and Usagestat remain separately installed dependencies.
The `--install-links` option installs a copy of the local SDK dependency for
packaging, instead of a link back into the source checkout.

## Build and install locally

```sh
npm run package:linux --prefix apps/desktop
node apps/desktop/scripts/install-local.mjs apps/desktop/release/linux-unpacked
```

Launch **AgenticDriver** from the application menu. The installer uses
`~/.local/share/agenticdriver/desktop` and the user application-menu directory
(or `XDG_DATA_HOME`), retains previous preview versions, and does not install a
system service. The archive is
`apps/desktop/release/AgenticDriver-0.2.0-alpha.5-linux-x64.tar.gz`.
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
   [owned Codex device sign-in](provider-sign-in.md), a write-only API key or an
   explicitly selected compatible gateway.
2. In **Connections**, name the application, review its provider access and
   lifetime, choose where its backend will connect, then create a one-use invitation. Paste it into the application's
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
performed by onboarding or metadata refresh. Preview `0.1.0-alpha.2` adds Codex
device sign-in on qualified Linux x64 hosts, with a separate private account
profile and explicit confirmation after native verification. Other native
providers use existing sessions. No provider/account/model fallback is added.

### Connect an application on another computer

The **Connection route** in **Connections** determines the address inside the
invitation. The destination preview does not contact that address, move operator
credentials or issue access. Creating an invitation does not prove the route is
reachable. These route controls and the recovery controls below require desktop
version `0.2.0-alpha.4` or later.

- **On this computer** uses the desktop's private loopback host. Choose this when
  the application backend runs on the same computer, not merely when its browser
  is open here.
- **Another computer · HTTPS** uses the reachable base URL of a TLS host or reverse
  proxy that routes to this selected host. Include any proxy path prefix. The SDK
  requires HTTPS without embedded credentials, query strings or fragments, and
  the connecting backend verifies the certificate. Configure the proxy separately;
  changing this field does not bind a new listener or open a firewall port.
- **Another computer · SSH tunnel** generates an invitation for a loopback port
  beside the application backend. Choose a free unprivileged port, then expand
  **SSH setup instructions**. Start one of the two displayed commands using your
  existing SSH access. A forward tunnel runs on the application machine and
  connects to the driver machine; a reverse tunnel runs on the driver machine and
  connects to the application server. Keep the chosen SSH session running.

### Manage an outbound SSH tunnel

Desktop **0.2.0-alpha.5 or later** adds **SSH tunnels** in **Connections** when
**This computer** is selected. Earlier downloads retain their manual SSH recipes.

1. Expand **Add an SSH tunnel**. Name it, enter an existing SSH alias or
   `user@hostname`, and choose an unused application-server port such as `17433`.
   Saving the route does not contact the server.
2. Choose **Start tunnel**. The desktop uses `/usr/bin/ssh` and your existing
   native SSH configuration, keys or agent. Set up and verify that destination
   in a terminal first; password prompts and unknown/changed host keys are
   rejected. Use an SSH alias for IPv6, custom SSH ports or jump-host settings.
3. Choose **Use for invitation**, review the application name, provider access
   and lifetime, then create its invitation. The address is loopback on the
   selected application server. Pair from the backend there, not from a browser
   or a different container's network namespace.

**Running** means OpenSSH accepted the requested forwarding, not that the
application has paired or a provider has passed inference. **Stopped** and
**Failed** routes cannot create managed-tunnel invitations. Failures explain
whether host trust, native sign-in, forwarding or reachability needs attention.
Use **Start tunnel** to reconnect explicitly. The saved port stays the same;
there is no automatic retry, port change, alternate server or transport fallback.
Use **Edit** on a stopped route to correct its name, destination or port. A changed
server or port requires a new invitation at that address in the application.

Stopping the tunnel or closing its local host ends only its owned SSH session.
The desktop asks before interrupting active paired requests. A separate worker
supervises OpenSSH and closes it if the owning desktop worker disconnects.
Saved tunnels remain stopped when the desktop next opens. Existing application
grants survive a tunnel restart and still expire or revoke on the SDK host;
**Remove** forgets the route, not those grants. Revocation blocks new authorized
requests and does not cancel an already-running request.

This is an optional outbound OpenSSH integration, with no hosted relay service.
It needs no inbound laptop listener beyond the existing private SDK host and no
new firewall rule on that laptop. The selected SSH server is a trusted transport
endpoint: SSH encryption ends there, and its administrators can observe traffic
on its loopback interface. Provider API keys and native login files stay on the
execution computer; scoped application bearer credentials travel inside SSH.
The SSH server must permit remote forwarding and honor the requested
`127.0.0.1` bind (for example, `GatewayPorts no`). A server configured to override
bind addresses can widen the listener; the desktop does not change that policy.

Each tunnel owns a private control socket. The initial SSH connection clears
ambient port forwards; a separate multiplexing request adds exactly the chosen
route. Agent/X11 forwarding, `LocalCommand`, `RemoteCommand`, password prompting,
background persistence and host-key updates are disabled. User-owned SSH
configuration remains trusted native configuration, including any `Match exec`,
proxy or jump commands it deliberately contains. The desktop accepts no shell
command, key contents or SSH password through its renderer or the remote SDK API.
Provider-key environment variables and Node preload settings are not passed to
SSH. See [OpenSSH options](https://man.openbsd.org/ssh.1) and
[configuration](https://man.openbsd.org/ssh_config.5).

Managed tunnels are qualified on Linux only. CLI users and other platforms can
keep using the manual recipes below; direct local and verified HTTPS connections
remain independent of SSH.

### Manual SSH recipes

For example, if this desktop listens on `127.0.0.1:7433` and the application-side
port is `17433`, choose one direction:

```sh
# On the application backend machine:
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:17433:127.0.0.1:7433 USER@DRIVER_HOST

# Or on the driver machine, connecting outward to the application server:
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:17433:127.0.0.1:7433 USER@APP_SERVER
```

Replace the uppercase destination with your existing SSH account and hostname;
use the actual port shown by the desktop. The invitation then targets
`http://127.0.0.1:17433/` on the application machine. Both recipes request a
loopback-only listener and stop when initial forwarding setup fails. The SSH
server must permit forwarding and honor the bind address; a successfully started
tunnel still does not prove that its ultimate target is reachable.
See the [OpenSSH forwarding options](https://man.openbsd.org/ssh.1).

The manual route displays these commands without running them. AgenticDriver
does not manage SSH keys, change server policy or provide a hosted relay.
A containerized application has its own network namespace;
place the tunnel beside its backend rather than assuming container loopback
reaches the host OS. For remote hosts already saved in the desktop, use their
saved address or an explicitly supplied HTTPS address; generate SSH recipes on
the computer that owns the local host.

After establishing the route, create the invitation and paste it into the
application's connection settings. Provider keys and native sessions remain on
the execution host. Existing TypeScript, Python, Go and Rust invitation APIs
consume this same address-and-one-use-code format without an API migration.

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

### Check and recover a saved host

In **Hosts**, pasting an invitation first shows its destination. This preview
only parses the invitation; it does not contact the host or exchange the code.
Check that the address is reachable from this computer before choosing **Connect
host**. A loopback address reaches this computer, including an existing local
tunnel; it does not identify the remote machine automatically.

**Check connection** reads the host's authenticated protocol endpoint. It reports
the last check time, protocol version and whether the credential grants provider
management. It performs no model calls and does not certify provider credentials
or model availability. Status is a dated observation, not continuous presence.
Expired, revoked, unreadable, unreachable, incompatible and untrusted-certificate
connections show their next recovery step. TLS verification stays enabled.

Expand **Connection settings** to rename a host or **Reconnect this host** with a
fresh invitation for the same address. Reconnection preserves the saved host ID,
name and provider preferences. A different destination must be added as another
host. A successful exchange writes a new private profile and atomically switches
the saved host to it; a failed exchange leaves the previous profile unchanged.
Old profiles remain private for clients already using them. Their grants still
expire normally or can be revoked explicitly by the host operator. Reconnecting
does not revoke grants or cancel active requests.

If the exchange succeeds but settings cannot be saved, the app retains both
profiles and reports the uncertain state. Reconcile the newly issued grant on the
host before creating another invitation; the app never repeats an exchange
automatically. The active private profile filename is recorded in `settings.json`
and is not exposed to the renderer. Removing the saved host removes these local
copies without revoking the host-side grants.

The renderer is sandboxed, has context isolation and no Node integration. A narrow,
validated IPC interface reaches a separate Node worker; long-lived credentials
stay there. The renderer loads only packaged assets through a restricted local
protocol, and new windows/navigation are denied except selected documentation
links and the exact official Codex device page opened by the user. This is local transport access control; applications
retain their existing authentication stack.

## Verification and preview

The desktop starts an empty actual local host. Add a real provider through the
provider panel or pair with an existing host. Account status and usage come from
those real connections. A connection check is distinct from a completed model run.

`npm run preview --prefix apps/desktop` opens a separate development profile with
the actual controller and SDK. It does not seed providers, usage or connections.
The former `--fixtures` mode and embedded simulated renderer smoke harness were
removed. Pure IPC/security and packaging checks remain in `npm test --prefix apps/desktop`.
Use [real connection checks](real-connections.md) for provider acceptance.
