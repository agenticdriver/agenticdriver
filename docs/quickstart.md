# Install and connect

Start with an explicitly selected real provider account and a meaningful prompt.
This guide targets AgenticDriver **0.2.0-rc.1**, with wire protocol **1.0**,
provider management, host invitations and the Linux desktop. Check the
[release inventory](releases.md) and [RC gate](release-candidate.md) for
publication availability and immutable artifacts before installing. Candidate
coordinates below become installable only after their channel is published. PyPI organization approval remains pending;
Python uses the reviewed GitHub wheel. Applications do not need a sibling SDK
checkout at runtime. The stable release remains 0.1.0. Upgrade management clients
and hosts together as described in the [migration notes](migrations.md).

## 1. Obtain the packages

The examples below use these exact package identities:

| Language              | Package                                                              |
| --------------------- | -------------------------------------------------------------------- |
| JavaScript/TypeScript | `@agenticdriver/sdk@0.2.0-rc.1` on npm                               |
| Python                | `agenticdriver-0.2.0rc1-py3-none-any.whl` from the GitHub prerelease |
| Go                    | `github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-rc.1`      |
| Rust                  | `agenticdriver = "=0.2.0-rc.1"` on crates.io                         |

For unreleased development changes, build from a reviewed SDK commit instead:

```sh
npm ci
npm run typecheck
npm run build
mkdir -p artifacts
npm pack --pack-destination artifacts
python3 -m pip wheel --no-deps ./clients/python --wheel-dir artifacts
cargo package --locked --manifest-path clients/rust/Cargo.toml
```

Keep the npm archive, Python wheel and Rust crate with their source revision and
checksums. Transfer those artifacts to the application machine. Read the version
from each artifact's package metadata; a source build can differ from a published
artifact with the same version and must retain its source revision and checksums.
The [compatibility matrix](compatibility.md) lists supported runtimes and tested
platforms. Read [migration notes](migrations.md) when updating a package or host.

## 2. Connect your provider account

On the execution machine, use a supported native CLI already signed into the
account you intend to use. The qualified Codex adapter requires CLI 0.157.0;
Claude Code 2.1.282 is also qualified. See [provider setup](providers.md) for
other adapters and their actual availability. Keep provider sign-in files on
this execution machine.

In a fresh application directory, install the published npm package:

```sh
npm init -y
npm install --save-exact @agenticdriver/sdk@0.2.0-rc.1
npx --no-install agenticdriver init --config ./driver/config.json \
  --provider codex --provider-id my-codex --account-id my-codex-account \
  --binary /absolute/path/to/codex \
  --account-directory /absolute/path/to/your/codex-home --management
npx --no-install agenticdriver serve --config ./driver/config.json
```

Replace the two native paths with your selected installation and signed-in
account profile. `init` creates a private driver token and separate operator
credential, and refuses to replace existing configuration. It does not sign in
to a provider or run a model.

In a second terminal, inspect the actual account catalog:

```sh
npx --no-install agenticdriver status --config ./driver/config.json --refresh
```

Download the [AgenticDriver brand brief](../examples/quickstart/brand-brief.txt)
as `brand-brief.txt`, choose an inexpensive model reported by your account, and run:

```sh
npx --no-install agenticdriver run --config ./driver/config.json \
  --provider my-codex --model YOUR_REPORTED_MODEL < brand-brief.txt
```

This submits a real model request and consumes that account's usage. Review its
answer; seeing a catalog alone does not prove execution. Stop the foreground
host with Ctrl+C when finished. See the [host guide](host.md) for service startup.

Applications keep their chosen authentication system. Before connecting real
users or a remote application, configure scoped host access through the
[application-owned auth contract](authentication.md#connect-an-existing-authorization-system)
or the alpha host's [connection flow](connections.md). The
[Better Auth/AuthYard deployment recipe](deployment.md) is an optional integration.
Keep provider API keys and native sign-in on the execution host; clients receive scoped driver
credentials through the chosen connection or application auth flow.
For a host on another computer, follow the [real remote connection guide](real-connections.md).

## 3. Connect a language client

The following examples share these application-supplied settings:

| Setting                    | Value                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AGENTICDRIVER_URL`        | The host's HTTPS URL, or loopback HTTP for a local host or SSH tunnel                                       |
| `AGENTICDRIVER_TOKEN_FILE` | A private file containing the scoped driver credential, such as the file created by `agenticdriver connect` |
| `AGENTICDRIVER_PROVIDER`   | An authorized provider instance ID from discovery                                                           |
| `AGENTICDRIVER_MODEL`      | An explicitly selected model reported by that account                                                       |
| `AGENTICDRIVER_INPUT_FILE` | A UTF-8 prompt file, such as the brand brief above or an application-owned example                          |
| `AGENTICDRIVER_CA`         | Optional private-CA PEM certificate; omit for ordinary trusted HTTPS                                        |

Use the application's credential manager to supply and rotate the token file;
never put credentials in URLs, source code or browser storage. Python, Go and
Rust read a current token when constructing this one-shot client. Long-lived
applications must obtain a fresh token before subsequent operations and preserve
the outcome of uncertain requests. JavaScript can resolve credentials for every
request. None of the clients replays model work automatically after expiry.

The [Prometheus validation receipt](validation/prometheus-real-2026-09-28.md)
records real requests using installed packages through an SSH connection. The
examples run once with the selected provider/model and do not select an alternate
account or billing route.

### JavaScript and TypeScript

Requires Node 22.13+. Install the package as above. Save the following as
`client.mjs` and run `node client.mjs`. For a private CA, set
`NODE_EXTRA_CA_CERTS` to its certificate path **before starting Node**.
TypeScript imports the same `AgenticClient`; see its [full guide](javascript.md).

<<< @/../examples/quickstart/client.mjs

[Download the example](../examples/quickstart/client.mjs).

### Python

Requires Python 3.10+. Download the reviewed wheel from the
[0.2.0-rc.1 release](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.1),
verify its [published checksum](https://github.com/agenticdriver/agenticdriver/releases/download/v0.2.0-rc.1/ASSET-SHA256SUMS), and install it into
the application's own environment:

```sh
python3 -m venv .venv
# Use .venv/Scripts/python.exe on Windows.
.venv/bin/python -m pip install /absolute/path/to/agenticdriver-0.2.0rc1-py3-none-any.whl
.venv/bin/python client.py
```

Save this as `client.py`. The synchronous client has no HTTP-library dependency.
Install the wheel with `[async]` to use `AsyncAgenticClient`.

<<< @/../examples/quickstart/client.py

[Download the example](../examples/quickstart/client.py) ·
[Python streaming, async and cancellation](../clients/python/README.md).

### Go

Requires Go 1.22+. Install the published version:

```sh
go mod init example.test/my-driver-client
go get github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-rc.1
go run .
```

This public version installs through the ordinary Go module proxy and checksum
database without GitHub credentials. CI also verifies a locally packed Go module
archive without `replace` directives.
Save the following as `main.go`. Ctrl+C cancels its context without imposing a
run deadline.

<<< @/../examples/quickstart/client.go

[Download the example](../examples/quickstart/client.go) ·
[Go transport and cancellation](../clients/go/README.md).

### Rust

Requires Rust 1.89+. Use the published crate:

```toml
[dependencies]
agenticdriver = "=0.2.0-rc.1"
```

Save the following as `src/main.rs` in a `cargo new` application and run
`cargo run`. This uses the default `blocking` feature. The separate `async`
client supports cancellation by dropping its stream/future; see the full guide
for runtime ownership and feature selection.

<<< @/../examples/quickstart/client.rs

[Download the example](../examples/quickstart/client.rs) ·
[Rust async, features and cancellation](../clients/rust/README.md).

## 4. Validate the application workflow

Provider instances belong to the host and have explicit account bindings.
Refresh discovery, inspect the instance's health and capabilities, and select a
model available to that account. A saved native sign-in does not prove model
access or safe SDK integration. The [provider guide](providers.md) distinguishes
implemented adapters, recorded real checks and observed native blockers.

There is **no default total run deadline or inactivity timeout**. Add a positive
`idleTimeoutMs` only if your application wants to cancel stalled work; genuine
model/tool progress resets it. Streaming and cancellation are in each language
guide. A cancelled request may already have produced effects, so reconcile its
recorded outcome before retrying. See [inactivity](timeouts.md) and
[idempotency](idempotency.md).

Next, run the [three installed application recipes](applications.md), add
[selected-context retrieval](retrieval.md), and connect the existing
[Usagestat backend](usagestat.md) for accounting.
