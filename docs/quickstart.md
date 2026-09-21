# Install and connect

Start with a synthetic workflow, then select a live provider deliberately.
AgenticDriver is a working **v0.1 SDK**, with protocol **1.0**. Registry packages
are not published yet. The commands below install built archives or an explicit
pushed Go revision; applications do not need a sibling SDK checkout at runtime.
The source repository is public. A registry release is a separate step; build the
development archives from the reviewed source while publication is pending.

## 1. Obtain the packages

Build from a reviewed SDK commit on a development machine:

```sh
npm ci
npm run check
mkdir -p artifacts
npm pack --pack-destination artifacts
python3 -m pip wheel --no-deps ./clients/python --wheel-dir artifacts
cargo package --locked --manifest-path clients/rust/Cargo.toml
```

Keep the npm archive, Python wheel and Rust crate with their source revision and
checksums. Transfer those artifacts to the application machine. Their current
versions are `0.1.0`; a local archive with that version is not a registry release.
The [compatibility matrix](compatibility.md) lists supported runtimes and tested
platforms. Read [migration notes](migrations.md) when updating a package or host.

## 2. Try a local mock

In a fresh application directory, install the npm archive:

```sh
npm init -y
npm install /absolute/path/to/agenticdriver-0.1.0.tgz
npx --no-install agenticdriver init --config ./driver/config.json
npx --no-install agenticdriver serve --config ./driver/config.json
```

In a second terminal in that directory:

```sh
npx --no-install agenticdriver run --config ./driver/config.json \
  --provider mock --model demo --input "Hello"
```

The response is `AgenticDriver is connected.` This is an offline fixture: no
provider account or model inference is used. `init` creates a loopback host and a
separate private development token file. It never replaces an existing config.
Stop the foreground host with Ctrl+C when finished. See the [host guide](host.md)
for paths, commands and provider configuration.

Application authentication uses **Better Auth paired with AuthYard**. Before
connecting real users or a remote application, follow the
[auth guide](authentication.md) and [remote deployment recipe](deployment.md).
The development token above is only a local fixture credential. Keep provider API
keys and native sign-in on the execution host; clients receive scoped driver
credentials from their application's auth flow.

## 3. Connect a language client

The following examples share five application-supplied settings:

| Setting                    | Value                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTICDRIVER_URL`        | The host's HTTPS URL, or loopback HTTP for the local mock                                                                      |
| `AGENTICDRIVER_TOKEN_FILE` | A private file containing the current driver OAuth access token; for the mock, the file referenced by its `tokens[0].tokenRef` |
| `AGENTICDRIVER_PROVIDER`   | An authorized instance ID from discovery; explicitly `mock` for the local fixture                                              |
| `AGENTICDRIVER_MODEL`      | A model exposed by that instance; explicitly `demo` for the local fixture                                                      |
| `AGENTICDRIVER_CA`         | Optional private-CA PEM certificate; omit for ordinary trusted HTTPS                                                           |

Use the application's credential manager to supply and rotate the token file;
never put credentials in URLs, source code or browser storage. Python, Go and
Rust read a current token when constructing this one-shot client. Long-lived
applications must obtain a fresh token before subsequent operations and preserve
the outcome of uncertain requests. JavaScript can resolve credentials for every
request. None of the clients replays model work automatically after expiry.

The examples below are executed against installed packages in the container CI
gate. That gate uses a native Better Auth service credential, the AuthYard
connector, a private CA and a synthetic model server. The same examples also run
against the local mock when you explicitly set `mock` and `demo`.

### JavaScript and TypeScript

Requires Node 22.13+. Install the archive as above. Save the following as
`client.mjs` and run `node client.mjs`. For a private CA, set
`NODE_EXTRA_CA_CERTS` to its certificate path **before starting Node**.
TypeScript imports the same `AgenticClient`; see its [full guide](javascript.md).

<<< @/../examples/quickstart/client.mjs

[Download the example](../examples/quickstart/client.mjs).

### Python

Requires Python 3.10+. Install into the application's own environment:

```sh
python3 -m venv .venv
# Use .venv/Scripts/python.exe on Windows.
.venv/bin/python -m pip install /absolute/path/to/agenticdriver-0.1.0-py3-none-any.whl
.venv/bin/python client.py
```

Save this as `client.py`. The synchronous client has no HTTP-library dependency.
Install the wheel with `[async]` to use `AsyncAgenticClient`.

<<< @/../examples/quickstart/client.py

[Download the example](../examples/quickstart/client.py) ·
[Python streaming, async and cancellation](../clients/python/README.md).

### Go

Requires Go 1.22+. Until a release tag is chosen, this explicit pushed SDK
revision contains the client. This is source-module installation, not a claim
that a semantic-version release has been published:

```sh
go mod init example.test/my-driver-client
go get github.com/hashimkarim/agenticdriver/clients/go@36d36ad813194de785e34c06d705b2d90537000c
go run .
```

This public revision installs through the ordinary Go module proxy and checksum
database without GitHub credentials. CI also verifies a locally packed Go module
archive without `replace` directives.
Save the following as `main.go`. Ctrl+C cancels its context without imposing a
run deadline.

<<< @/../examples/quickstart/client.go

[Download the example](../examples/quickstart/client.go) ·
[Go transport and cancellation](../clients/go/README.md).

### Rust

Requires Rust 1.89+. Extract the built
`clients/rust/target/package/agenticdriver-0.1.0.crate` into the application's
`vendor/` directory, then use its **packaged** source:

```toml
[dependencies]
agenticdriver = { path = "vendor/agenticdriver-0.1.0" }
```

Save the following as `src/main.rs` in a `cargo new` application and run
`cargo run`. This uses the default `blocking` feature. The separate `async`
client supports cancellation by dropping its stream/future; see the full guide
for runtime ownership and feature selection.

<<< @/../examples/quickstart/client.rs

[Download the example](../examples/quickstart/client.rs) ·
[Rust async, features and cancellation](../clients/rust/README.md).

## 4. Choose a real execution route

Provider instances belong to the host and have explicit account bindings.
Refresh discovery, inspect the instance's health and capabilities, and select a
model available to that account. A saved native sign-in does not prove model
access or safe SDK integration. The [provider guide](providers.md) distinguishes
API adapters, restricted CLI fixtures and observed native blockers.

There is **no default total run deadline or inactivity timeout**. Add a positive
`idleTimeoutMs` only if your application wants to cancel stalled work; genuine
model/tool progress resets it. Streaming and cancellation are in each language
guide. A cancelled request may already have produced effects, so reconcile its
recorded outcome before retrying. See [inactivity](timeouts.md) and
[idempotency](idempotency.md).

Next, run the [three installed application recipes](applications.md), add
[selected-context retrieval](retrieval.md), and connect the existing
[Usagestat backend](usagestat.md) for accounting.
