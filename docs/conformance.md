# SDK verification

The current SDK contains no mock provider, fake model server or simulated
connection harness. `npm run check` runs type checks, pure validation and storage/
process checks, then builds the runtime and portable provider component.
`npm run test:package` installs an actual npm archive and checks its public exports.
`npm run test:clients` installs the Python wheel and Rust crate, compiles their
examples and runs pure client contracts, including Go's packaged component.
Static schema inputs are validation data, never a connected provider.

Run actual provider acceptance through [real connections](real-connections.md),
with an explicit connection, account, exact model and meaningful prompt. Discovery,
execution and application quality are separate results. Record CLI versions,
transport, selected model, output and measured usage; do not infer successful
execution from a green catalog status.

The previous simulated conformance suites were removed. Their old release reports
under `docs/validation` remain historical evidence only. Features formerly covered
by those suites need real qualification before a production support claim;
build success alone does not establish streaming, tools, RAG or recovery behavior.
