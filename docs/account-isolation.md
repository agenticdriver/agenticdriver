# Dedicated Linux account containers

Use one execution host and Compose project per native account when accounts must
not share a filesystem or process namespace. This opt-in recipe supports the
qualified Linux x64 Codex 0.157.0 and Claude Code 2.1.282 runtimes. It does not move
an existing desktop sign-in or require application authentication changes.

The host runs as UID/GID 1000, with a read-only root filesystem, all capabilities
dropped, no-new-privileges, default seccomp, 1 GiB memory and 256-process limits.
Only its own account home/state volumes persist. Temporary invocation files live
in a bounded tmpfs. There is no host home, sibling account, SSH agent or Docker
socket mount. A separate TLS proxy shares the execution network namespace; the
SDK itself binds only loopback. Network egress is available for the provider.

The operator, Docker daemon and shared Linux kernel remain trusted. Native code
can access its own account and this host's driver credentials. Do not put secrets
belonging to mutually untrusted applications inside the same account container.
Restricted provider flags do not replace the outer account boundary.

## Build and provision

Build from a reviewed checkout. No credential is read by these build commands:

```sh
docker build --target runtime -t agenticdriver:local .
docker build -f deploy/Dockerfile.proxy -t agenticdriver-proxy:local deploy
docker build -t agenticdriver-account:local deploy/account
# Select the native runtime needed for this account.
docker build -f deploy/account/Dockerfile.codex -t agenticdriver-account:codex deploy/account
# Or: Dockerfile.claude / agenticdriver-account:claude
```

The native Dockerfiles pin the executable version and verify its digest. Copy
`deploy/account/compose.yaml`, `deploy/account/config.example.json` and
`deploy/Caddyfile` into a new private deployment directory:

```text
account/
  compose.yaml
  Caddyfile
  runtime/config/config.json
  runtime/secrets/driver-token
  runtime/tls/server.crt
  runtime/tls/server.key
```

Replace the example instance/account/host/subject/token identifiers with explicit
non-secret labels. For Claude use kind `claude-code`, binary `/usr/local/bin/claude`
and account directory `/home/node/.claude`, and omit Codex reasoning effort.
A missing provider, multiple providers, broad provider grants, alternate home or
binary paths and state outside the dedicated volume are rejected.

Create the bearer directly in the private secret file; never put it in an image,
URL, command line or logs. Use a certificate valid for the endpoint and configure
client trust; never disable TLS verification. Follow the existing
[ownership and SELinux guidance](deployment.md). Mounted files and directories
must be readable by UID 1000; credential files should be mode 0600 and their
private parent directories mode 0700.

Each provider's normal sign-in must be provisioned deliberately in this project's
own account-home volume, with the execution host stopped. An operator may instead
explicitly provision an authorized existing sign-in in a private account volume,
subject to that provider's supported storage contract. This recipe never copies
credentials automatically. Directory ownership matters: the native runtime must
be able to write its own state without changing the original host account.

```sh
AGENTICDRIVER_ACCOUNT_IMAGE=agenticdriver-account:codex \
  docker compose -p my-codex-account up -d --wait --no-build
```

Set a different `AGENTICDRIVER_HTTPS_PORT` for each deployment. The default bind
is host loopback; a remote app uses a deliberately configured HTTPS route or the
[supported SSH tunnel](real-connections.md). Check native account/catalog metadata
before requesting a model. Saved login, reported model availability and successful
execution remain distinct. The configuration grants no provider management.

## Cancellation, restart and updates

No generation deadline or inactivity timeout is configured by default. SDK
cancellation terminates its native process group and removes invocation files.
An intentionally detached process group requires the outer boundary: stopping
that account container removes its remaining processes and temporary filesystem.
The Compose stop grace is an operator shutdown bound, not an inference timer.

```sh
docker compose -p my-codex-account stop driver
# After reviewing configuration, current image and the reason for stopping:
docker compose -p my-codex-account up -d --wait --no-build driver
```

Automatic restart is disabled. Home/state volumes survive and interrupted work
is not replayed. Drain work before replacing config or a runtime image, preserve
private state through the operator's encrypted backup process, and retain the
previous compatible image for rollback. Never delete account volumes as a normal
upgrade step. Other accounts and app hosts stay running.

## Real qualification

[The RC gate](release-candidate.md) requires real execution and inspected controls.
The qualification script operates only on two explicitly selected disposable
account deployments. It does not provision sign-ins or build an image for you.
Mount `deploy/account/qualify.mjs` as `runtime/config/qualify.mjs`, and copy the
selected test CA to `runtime/config/ca.crt`. Use private, explicitly provisioned
Codex/Luna-medium and Claude/Haiku accounts. The private manifest is an array:

```json
[
  {
    "kind": "codex",
    "container": "EXACT_DRIVER_CONTAINER_ID",
    "proxy": "EXACT_PROXY_CONTAINER_ID",
    "model": "gpt-6-luna",
    "base": "/private/disposable-codex"
  },
  {
    "kind": "claude",
    "container": "EXACT_OTHER_DRIVER_CONTAINER_ID",
    "proxy": "EXACT_OTHER_PROXY_CONTAINER_ID",
    "model": "claude-haiku-4-5-20251001",
    "base": "/private/disposable-claude"
  }
]
```

`base` is the corresponding private deployment directory on the computer running
the command; the script reads its existing token file only to check rejection by
the other account. The native account credentials stay in their selected volumes.

```sh
node --test deploy/account/policy.test.mjs  # after npm run build; pure config checks
python3 scripts/qualify-account-isolation.py \
  --accounts /private/disposable-accounts.json \
  --output /private/new-isolation-receipt.json --allow-stop --execute
```

`--execute` sends one meaningful release-handoff prompt and one explicitly
cancelled request per account. Omitting it performs metadata and boundary checks
only. `--allow-stop` authorizes the selected disposable containers' stop/restart
checks. The receipt is created exclusively with private permissions and includes
actual model output for review; do not commit it without redaction. An optional
`--docker-container` selects an already configured Docker-in-Docker engine, as on
Prometheus. It is not permission to mount that daemon into an account host.

The script inspects account separation, effective runtime controls, wrong-account
credential rejection, cleanup, deliberately detached process termination at
container stop, temporary-file removal, persistent state and catalog recovery.
The account-policy tests neither start a provider nor simulate a response.
macOS/Windows, hostile-kernel escape resistance and private production workloads
are not qualified by these checks.
