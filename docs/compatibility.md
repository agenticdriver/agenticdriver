# Compatibility and fault testing

The [SDK checks workflow](../.github/workflows/ci.yml) declares these combinations.
A green run validates its exact dependency resolutions and hosted runner image;
it does not certify other OS releases or vendor accounts. Minimum versions are
compatibility targets; upstream maintained releases remain the deployment choices.

| Runner                  | Node.js    | Python | Go     | Rust   | Installation and execution checks                             |
| ----------------------- | ---------- | ------ | ------ | ------ | ------------------------------------------------------------- |
| Ubuntu 24.04 x64        | 22.13.0    | 3.10   | 1.22   | 1.89.0 | Complete host/package suite and all four clients              |
| Ubuntu 24.04 x64        | 24 LTS     | 3.14   | stable | stable | Complete host/package suite and all four clients              |
| Ubuntu 24.04 x64        | 26 Current | 3.14   | stable | stable | Complete host/package suite and all four clients              |
| macOS 15 arm64          | 24 LTS     | 3.14   | stable | 1.89.0 | Complete host/package suite and all four clients              |
| Windows Server 2022 x64 | 24 LTS     | 3.14   | 1.22   | 1.89.0 | Programmatic runtime, installed packages and all four clients |

Node 22.13.0 is the package minimum, including the optional SQLite-backed
services exposed by the main entry. Python requires 3.10, Go 1.22 and Rust 1.89.
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

The TypeScript runtime, HTTP host and API adapter fixtures run on each row. The
Windows package check uses `--package-only`: it runs the installed programmatic
host, browser/client, provider-extension, jobs and diagnostics examples, but
does not claim the service CLI's POSIX signal shutdown/restart behavior. Its
fixture host shuts down through a test-only IPC channel. Windows process-tree
isolation, native CLI wrappers and OS credential/ACL certification remain in
AD-012 and the provider-specific live work. POSIX executable/symlink/process
fixtures are identified explicitly where they are unavailable on Windows.

The matrix is based on the [Node release schedule](https://nodejs.org/en/about/previous-releases),
[Python releases](https://www.python.org/downloads/), [Go releases](https://go.dev/dl/)
and [GitHub runner images](https://github.com/actions/runner-images). Named OS
labels avoid silently following `*-latest` migrations. Node 26 is a Current
compatibility row, not an assertion of upstream LTS status.

## Reproduce the checks

Install Node/npm, Python with `venv`, Go with its race-detector C compiler, Rust
via rustup, OpenSSL and Poppler (`pdfinfo` and `pdftotext`). Then run:

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
```

Default tests use synthetic accounts, API responses, native process fixtures and
an independent local reference server. They do not run an installed provider
CLI or use its sign-in. Native binaries are opt-in, such as the
[no-prompt Antigravity readiness command](validation/antigravity-2026-09-21.md).
An account/model must be explicitly selected for inference certification.

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
