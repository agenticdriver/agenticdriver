# Installable execution host

The `agenticdriver` command runs the same runtime as the TypeScript SDK. It needs
Node.js 22 or newer. Applications in any supported language connect through the
authenticated HTTP/HTTPS protocol; only the execution host needs Node.js.
Optional [durable jobs](jobs.md) require Node 22.13+, explicit SQLite storage and
retention, stable account bindings and separate token job grants.

## Install and run a mock workflow

This checkout has not been published to npm. Build a local package and install
the resulting archive, without depending on a sibling source checkout:

```bash
# In the SDK checkout
npm ci
npm run check
npm pack

# In an application directory; replace the path with your actual archive
npm install /absolute/path/to/agenticdriver-0.1.0.tgz
npx --no-install agenticdriver init
npx --no-install agenticdriver doctor
npx --no-install agenticdriver serve
```

In another terminal in that application directory:

```bash
npx --no-install agenticdriver status
npx --no-install agenticdriver run --provider mock --model demo --input "Hello"
```

The mock returns `AgenticDriver is connected.` without model inference or external
credentials. `init` creates a loopback listener, a random driver token in a separate
private file, and a durable operation directory reference. It never replaces an
existing configuration. Choose `--config /another/path/config.json` to create an
independent host. The CLI is also available with a user-owned npm global installation
of the archive (`npm install --global /absolute/path/to/archive.tgz`).

`npm run test:install` builds and installs an archive into an empty temporary
application, then exercises these commands and an explicitly selected API fixture.
It also tests cancellation and recovery after a host restart. This is installation
and protocol evidence; real account certification is tracked separately.

## Select a provider explicitly

Create an API host configuration with a model supported by your account:

```bash
npx --no-install agenticdriver init --config ./driver/config.json \
  --provider openai --provider-id company-api --model YOUR_MODEL \
  --api-key-env OPENAI_API_KEY
npx --no-install agenticdriver doctor --config ./driver/config.json
npx --no-install agenticdriver serve --config ./driver/config.json
```

Supply `OPENAI_API_KEY` to the host through your environment or secret manager.
The configuration contains its environment variable name, never its value. API
kinds are `openai`, `anthropic`, `gemini`, `xai`, and `openai-compatible`. The last
requires `--base-url`; HTTPS is required except for loopback development endpoints.
Custom `extension` entries require a custom host's statically imported registry
and an exact version pin; the stock CLI does not dynamically load packages.
See the [extension host example](provider-extensions.md).
Model selection is required for every non-mock initialization and every run:

```bash
npx --no-install agenticdriver run --config ./driver/config.json \
  --provider company-api --model YOUR_MODEL --input "Suggest three brand names."
```

For an installed CLI, use its official sign-in as the OS user who will run the
host, then initialize with `--provider codex`, `claude-code`, or `gemini-cli` and
`--model YOUR_MODEL`. `--account-directory` selects a dedicated account directory;
`--binary` selects an installed executable. No credentials are extracted from a
subscription or converted to API keys. See [provider setup](providers.md) for the
supported restrictions and current certification limits.

`init` also writes a persistent `usage.hostId`. Add `--account-id YOUR_OPAQUE_ID`
to bind the selected provider to a known account for metering and quota joins.
Existing configurations can set each provider's `accountId` together with
`usage.hostId`; `usage.labels` and `usage.retentionDays` are optional host metering
policy. See [account-scoped usage](usage.md) before sending records to shared storage.

## Commands and configuration paths

| Command  | Behavior                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------- |
| `init`   | Creates a new configuration and a separate random token file.                                      |
| `serve`  | Validates config, resolves host credentials, and listens in the foreground.                        |
| `doctor` | Validates config, driver token and TLS references; checks configured providers without generation. |
| `status` | Connects with a configured driver token, negotiates the protocol, and returns scoped discovery.    |
| `run`    | Runs an explicit provider/model pair; reads UTF-8 stdin when `--input` is omitted.                 |

`--json` prints machine-readable JSON; `run --json` emits JSONL protocol events.
Errors use fixed public codes/messages on stderr. A failed command exits with 1.
`doctor` also exits with 1 for unavailable, rejected, or missing credentials. CLI
health `unknown` can exit successfully because saved sign-in state does not prove
remote account validity; inspect each provider's health code before presenting it
as connected. `status --refresh` requests a new scoped provider check.

Configuration selection is, in order, `--config`, `AGENTICDRIVER_CONFIG`, then:

| OS      | Default path                                                                                  |
| ------- | --------------------------------------------------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/agenticdriver/config.json`, otherwise `~/.config/agenticdriver/config.json` |
| macOS   | `~/Library/Application Support/agenticdriver/config.json`                                     |
| Windows | `%APPDATA%\agenticdriver\config.json`, otherwise the user's `AppData\Roaming` directory       |

Paths in the configuration resolve against its directory. No `~` or shell
expansion occurs inside JSON strings. Use an absolute `binary` path for services
whose executable search path differs from your terminal. Host config files are
limited to 1 MB and must be regular UTF-8 JSON files. Unknown fields and inline
credentials are rejected. The editor schema is
[`protocol/host-config.schema.json`](../protocol/host-config.schema.json).

This configuration exposes two account instances to one application subject:

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 7433 },
  "providers": [
    {
      "kind": "openai",
      "id": "company-api",
      "models": ["YOUR_API_MODEL"],
      "apiKeyRef": { "env": "OPENAI_API_KEY" }
    },
    {
      "kind": "codex",
      "id": "personal-codex",
      "models": ["YOUR_CLI_MODEL"],
      "accountDirectory": "/absolute/path/to/dedicated/codex-home"
    }
  ],
  "tokens": [
    {
      "id": "brandstorm",
      "subject": "brandstorm-user",
      "tokenRef": { "file": "credentials/brandstorm.token" },
      "providers": ["company-api", "personal-codex"],
      "tools": []
    }
  ],
  "operations": { "directory": "state/operations" },
  "usageLog": "state/usage.jsonl"
}
```

Replace model/directory placeholders and supply the separate driver credential
before running this example. Every token must resolve to a distinct, single-line
value of at least 32 characters. `init` generates a cryptographically random value.
`--token-id` selects a token for `status` or `run`; the first is used if omitted.
Clients only see authorized provider instances. Models are an explicit allowlist;
there is no account, model, or billing fallback.

Optional `limits` cap `maxSteps`, `maxOutputTokens`, `maxAttempts` and
`idleTimeoutMs`. **There is no total run deadline and no default inactivity
timeout.** Omitted or zero `idleTimeoutMs` disables inactivity cancellation unless
a positive host policy applies. Real model/tool progress resets an enabled idle
timer. `run --idle-timeout-ms` is an application choice. Retries are opt-in through
`run --max-attempts`; see [retry and idempotency semantics](idempotency.md).
`concurrency.total` and `concurrency.perSubject` set simultaneous run limits.
Optional `perAccount`, `subjects`, `accounts` and a bounded `queue` add fair
admission; `resources` configures observed per-run token/cost limits with explicit
unknown-usage behavior. See [scheduling and resource policies](scheduling.md),
including the Usagestat quota helper and the limits of observed budgets.

## Secret references and diagnostics

Custom hosts can attach [optional diagnostics](diagnostics.md) through
`configuredDriver(config, { diagnostics })`. Structured records and the
OpenTelemetry bridge exclude content by construction, bound exporter queues,
and isolate exporter failure from run execution. Correlation headers require
the separate `diagnosticHeaders: true` server option.

Every credential reference uses exactly one mechanism:

| Reference                                                          | Resolution                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `{"env":"NAME"}`                                                   | Supplied process environment. No automatic `.env` loading.                        |
| `{"file":"credentials/key"}`                                       | Private regular UTF-8 file, at most 64 KiB. POSIX group/other access is rejected. |
| `{"keychain":{"service":"agenticdriver","account":"company-api"}}` | Explicit OS keychain lookup under the host's OS account.                          |

Linux keychain lookup uses `secret-tool lookup service ... account ...` through
libsecret/Secret Service. macOS uses `/usr/bin/security find-generic-password`
with explicit service/account selectors. Helpers run without a shell and their
output is retained only as a secret value. Lookup has a five-second housekeeping
bound. An unavailable helper, locked session, or unreadable entry returns a
redacted failure; there is no fallback to a different secret. See the upstream
[libsecret helper](https://gnome.pages.gitlab.gnome.org/libsecret/coverage/tool/secret-tool.c.gcov.html)
and [Apple security command](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c).

Provision keychain entries using your secret manager. A Linux desktop's unlocked
keychain may be unavailable to a headless service; use a service-supplied private
file or environment reference there. On Windows, those two mechanisms are
supported; native Credential Manager integration is not implemented. Set a file's
ACL to the host account on Windows; POSIX permission bits do not validate Windows
ACLs. OS keychain compatibility has not yet been certified across the OS matrix.

`doctor` and `status` never return resolved provider keys, bearer tokens, TLS keys,
raw provider errors, or CLI authentication output. Provider names/model IDs and
health are visible to authorized users. Keep secrets out of display names and
paths. `run` intentionally prints generated text and requested tool events, so its
output may contain application data. Durable operation records contain tool
arguments/results and generated output; keep their directory private. The
optional usage log contains metering records without prompts or model output.

API secret references resolve for each new model turn; update a private file or
secret-store entry to rotate credentials. Process environment changes require a
restart. Driver bearer tokens and TLS identity are loaded when `serve` starts;
restart after changing them. Never delete operation records as a rotation step.

Embedding applications can import `configuredDriver`, `configuredServer`,
`configuredClient`, and `readHostConfig` from `agenticdriver/host` and supply a
`SecretResolver` for their own store. Registered tools and approval callbacks are
also supplied programmatically; config JSON cannot load arbitrary executable code.

## TLS and remote connections

Loopback is the default. A non-loopback bind requires configured TLS and bearer
authentication. Add, for example:

```json
{
  "listen": { "host": "0.0.0.0", "port": 7433 },
  "clientUrl": "https://driver.example.com:7433",
  "tls": {
    "certFile": "tls/fullchain.pem",
    "keyRef": { "file": "credentials/tls-private-key.pem" }
  },
  "allowedOrigins": ["https://your-application.example"]
}
```

Merge these fields into a full configuration. The certificate must match the
client hostname and a trusted CA. For a private CA, set Node's
`NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` before starting the CLI client; do
not disable certificate verification. `--url` overrides `clientUrl` for a client
command. When `--port 0` selects a temporary port, use the URL printed by `serve`.
The host can also stay on loopback behind an authenticated TLS reverse proxy;
SSE responses need buffering disabled and support for long-lived connections.

## Run as a service and upgrade

Run under the intended ordinary OS user. That user owns the configuration,
credentials, CLI sign-in directories and persistent operation records. The CLI
does not install a service, change privileges, or copy another user's account.

On Linux, this systemd **user** unit can supervise a user-owned installation.
Replace the Node and CLI paths with the absolute installed paths, and put it in
`~/.config/systemd/user/agenticdriver.service`:

```ini
[Unit]
Description=AgenticDriver execution host

[Service]
Type=exec
ExecStart=/absolute/path/to/node /absolute/path/to/agenticdriver/dist/cli.js serve --config %h/.config/agenticdriver/config.json --json
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agenticdriver.service
systemctl --user status agenticdriver.service
systemctl --user stop agenticdriver.service
```

There is no `User=` override in this user unit. Supply secrets to this user's
service environment or use file/keychain references. `KillMode=mixed` gives the
host the initial termination signal so it can cancel its children; the supervisor
can force termination after the stop grace period. `TimeoutStopSec` applies only
after shutdown is requested, not to active model runs. See upstream
[service settings](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
and [termination behavior](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

On macOS, a user LaunchAgent in `~/Library/LaunchAgents` can run the same absolute
Node/CLI arguments with `serve --config ...`. Set its `Label`, `ProgramArguments`,
and output paths, and run it as the signed-in user whose keychain/CLI account is
selected. Launchd sends `SIGTERM` on logout; see Apple's
[LaunchAgent guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
On Windows, the supported entry point is the foreground Node process. Use Ctrl+C
for graceful console shutdown. A native Windows service installer and service
control adapter are not supplied by this release.

`SIGINT`/`SIGTERM` stop accepting connections, cancel active runs and provider
processes, close HTTP connections, and wait for request cleanup/operation records.
The host does not let unfinished runs silently continue after the application
disconnects. Restarting does not automatically resume generation. Recover a
keyed operation by submitting the identical request and idempotency key: completed
results replay, cancelled operations retain cancellation, and crash-interrupted
records report uncertainty. This does not undo external tool effects.

For an upgrade, stop the host, retain the current archive plus private config and
state backups, install the new archive, run `doctor` as the same OS user, then
start the host and run `status`. Use `systemctl --user restart` after installation
only when cancellation of active requests is acceptable. Do not run `init` over
an existing config, delete operation records, or change subjects to work around
recovery errors. Roll back the package with the retained archive only when its
configuration and stored-record versions are compatible. Forced termination can
leave an accepted operation uncertain; reconcile its effects before replacement.

For durable metering, configure the optional `usagestat` URL and `tokenRef`,
a persistent `usage.hostId`, and an `accountId` on each provider. See
[Usagestat integration](usagestat.md) for local/remote backend setup, retention,
forwarding and capture-failure semantics.

Interactive approvals are opt-in: configure `approvals: { "interactive": true }`
and a token's `approveTools` list separately from its invocation `tools` grant.
Embedders still register tools and can provide a private `onApprovalAudit` sink.
Hosts may forbid inactivity pausing with `allowIdlePause: false`; there is no
default approval expiry. See [interactive approvals](approvals.md) for the
request, decision and cancellation contract.

Application-owned functions can execute in any language client without installing
code on the host. Enable `applicationTools: { "enabled": true }` and grant each
permitted name through the token's `applicationTools` array. Host and token review
requirements default to enabled. Progress/results use the same host process as
the originating stream; these requests can resolve waiting runs at full run
capacity. See [application-owned functions](application-tools.md).

Conversation storage is opt-in through `sessions: { "retentionMs": 86400000 }`, explicit token `sessions` operation grants, and each provider's `accountId`. Storage is process-local; idle retention pauses during active turns. See [conversation sessions](sessions.md).
