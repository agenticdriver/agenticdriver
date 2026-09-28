# Package checks

`npm run build` cleans the previous output before compiling, so deleted providers
cannot survive in a stale distribution directory. The same provider component is
bundled into npm, Python, Go and Rust artifacts.

`npm run test:package` creates an actual npm archive, installs it into a fresh
application, verifies public imports and confirms that the removed mock provider,
fake embedding adapter and simulated conformance export are absent.

`npm run test:clients` builds and installs the Python wheel and Rust crate,
checks type declarations and feature combinations, and runs the remaining pure
language contracts. No provider connection is created or simulated by these checks.

The release candidate workflow builds exact archives and checksums, verifies their
contents, and installs/compiles examples from those archives. Builds and checks run
on Prometheus. Publication verifies the exact candidate bytes; see [release controls](releases.md).

Live acceptance is separate: use the [real connection runner](real-connections.md)
against the candidate host and installed clients, recording actual account/model,
versions, prompts, responses and usage. No successful package/build check is labeled
as successful inference.
