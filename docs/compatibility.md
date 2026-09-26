# Compatibility and fault testing

The [SDK checks workflow](../.github/workflows/ci.yml) runs on the repository's
Prometheus Linux x64 runner, using an Ubuntu 24.04 container userspace and the
Fedora host kernel. GitHub-hosted compute is disabled as of 2026-09-25. See the
[runner operations guide](../deploy/ci-runner/README.md) for its trust boundary,
registration, prerequisites and recovery. A green run validates its exact
commit/dependency resolutions, not other OS releases or vendor accounts.
Minimum versions are compatibility targets; upstream maintained releases remain
the deployment choices.

| Status | Runner | Node.js | Python | Go | Rust | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| Active | Prometheus Linux x64 | 22.13.0 | 3.10 | 1.22 | 1.89.0 | Complete host/package suite and all four clients |
| Active | Prometheus Linux x64 | 24 LTS | 3.14 | stable | stable | Complete host/package suite and all four clients |
| Active | Prometheus Linux x64 | 26 Current | 3.14 | stable | stable | Complete host/package suite and all four clients |
| Paused | macOS 15 arm64 | 24 LTS | 3.14 | stable | 1.89.0 | Historical hosted coverage; no compatible self-hosted runner |
| Paused | Windows Server 2022 x64 | 24 LTS | 3.14 | 1.22 | 1.89.0 | Historical hosted coverage; no compatible self-hosted runner |

The last full hosted run before this migration passed at
[`dd16f2f`](https://github.com/agenticdriver/agenticdriver/actions/runs/36162484839).
The hosted run for `6f72acc` was cancelled on the user's compute instruction;
it is not successful CI evidence. Linux success on Prometheus does not renew
macOS/Windows certification. No PR code runs on this persistent runner.

Node 22.13.0 is the package minimum, including the optional SQLite-backed
services exposed by the main entry. Python requires 3.10, Go 1.22 and Rust 1.89.
The separate [Better Auth/AuthYard integration](authentication.md) requires
Node 24+ for the application auth runtime. Its pinned real-package contracts run
on the Node 24/26 rows; this does not raise the core SDK/client minimum.
The Rust package is checked with neither feature, `async`, `blocking`, and both.
`stable` selects the current upstream stable toolchain when CI runs; setup logs
record the resolved version. `AGENTICDRIVER_TEST_RUST_TOOLCHAIN` overrides the
test harness toolchain, never application model or provider selection.

These rows cover actual package artifacts: npm archives installed in independent
applications, Python wheels in fresh virtual environments, Go module archives
installed through a private local file proxy without `replace`, and Rust crates
extracted into external applications. The Go archive check does not publish a
version or require repository credentials. A separately authorized published
revision can still be checked with `scripts/test-go-install.py COMMIT_OR_TAG`.

The TypeScript runtime, HTTP host and API adapter fixtures run on each active row.
The historical Windows package check uses `--package-only`: it runs the installed programmatic
host, browser/client, provider-extension, jobs and diagnostics examples, but
does not claim the service CLI's POSIX signal shutdown/restart behavior. Its
fixture host shuts down through a test-only IPC channel. Windows process-tree
isolation, native CLI wrappers and OS credential/ACL certification remain in
AD-012 and the provider-specific live work. POSIX executable/symlink/process
fixtures are identified explicitly where they are unavailable on Windows.

The matrix is based on the [Node release schedule](https://nodejs.org/en/about/previous-releases),
[Python releases](https://www.python.org/downloads/), [Go releases](https://go.dev/dl/)
and [GitHub runner images](https://github.com/actions/runner-images). The former named hosted OS
labels remain historical references while their rows are paused. Node 26 is a Current
compatibility row, not an assertion of upstream LTS status.

## Reproduce the checks

Install Node/npm, Python with `venv`, Go with its race-detector C compiler, Rust
via rustup, OpenSSL 3+ and Poppler (`pdfinfo` and `pdftotext`). On macOS, CI
uses Homebrew `openssl@3` explicitly for certificate generation. TLS fixtures
verify their generated CA/leaf chain before using it. Then run:

```sh
npm ci
npm run check
npm run protocol
git diff --exit-code -- protocol/openapi.json protocol/host-config.schema.json protocol/usage-record.schema.json protocol/provider-extension.schema.json
npm run test:clients
python scripts/test-go-install.py --local-archive
npm run test:install
# Windows installed-package row:
npm run test:install -- --package-only
# Node 24+; real Better Auth and AuthYard package contracts:
npm run test:auth
# Docker Compose, OpenSSL and the four language toolchains:
npm run test:deployment
# Independent static documentation build:
npm ci --prefix site
npm run build --prefix site
```

The Linux container job installs all four clients and executes the documented
quickstarts through verified TLS and the native Better Auth service flow. It
checks proxy cancellation, capacity rejection, graceful shutdown, durable replay
after host and proxy replacement, and token revocation with a synthetic model
endpoint. See the [deployment recipe](deployment.md). The separate documentation
job builds the [site](../site/README.md), checks its Markdown links and retains a
preview artifact. Neither job publishes a service or certifies a live account.

Default tests use synthetic accounts, API responses, native process fixtures and
an independent local reference server. They do not run an installed provider
CLI or use its sign-in. Native binaries are opt-in, such as the
[no-prompt Antigravity readiness command](validation/antigravity-2026-09-21.md).
An account/model must be explicitly selected for inference certification.

The opt-in [native Codex fixture](validation/codex-2026-09-25.md) runs the actual
Linux CLI against a loopback-only Responses service in a separate network
namespace. It checks synthetic account selection, reasoning effort, progress,
usage, managed-session refresh/expiry, error codes, cancellation and process
cleanup without using a real sign-in. It inspects Responses Lite `additional_tools`
catalogs and attempts denied native operations, including filesystem access and
network fetches from the code runtime.
It records inherited native context separately from passing execution checks.

The [Claude native qualification](validation/claude-2026-09-26.md) covers Linux
x64 CLI 2.1.282: offline streaming/cancellation, empty tools, ambient-context
isolation, model refusal without fallback and native catalog discovery. Its
separate Prometheus job runs without external networking or real accounts.
The dated report records two selected local Haiku 4.5 calls and Usagestat capture;
it does not certify every discovered model or a hosted consumer-auth deployment.

## Failure coverage

`tests/network-faults.test.ts` puts a real HTTP proxy between the client and host:

- A buffering proxy withholds streamed bytes; explicit cancellation still
  reaches the active provider without retrying it.
- A paused application iterator receives a large event through proxy writable
  backpressure, then cancels the active provider.
- A proxy returns a clean HTTP EOF after losing the terminal SDK event; the
  client reports an incomplete stream and the provider is cancelled once.
- An untrusted certificate and a trusted certificate for the wrong hostname
  fail the TLS handshake before any authenticated HTTP request reaches the host.

The shared [conformance suite](conformance.md) additionally exercises fragmented
UTF-8/SSE, malformed and oversized responses, truncated/reordered events,
redirect refusal and cancellation for every client over HTTP and verified HTTPS.
Server, scheduling, approval and application-tool fixtures cover cancellation
races, capacity errors and shutdown. Fake clocks advance silent runs by a week
and queued work by 30 days to prove the absence of default run/inactivity
deadlines. Explicit inactivity tests reset only on real provider/tool progress.

Test watchdogs and native readiness deadlines bound test infrastructure. They
are not SDK run defaults. Real provider, proxy, deployment and subscription
limits require their separately recorded validation; fixture success does not
establish those limits.
