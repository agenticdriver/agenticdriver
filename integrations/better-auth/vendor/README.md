# AuthYard contract-test dependency

`authyard-better-auth-0.3.1.tgz` is the actual MIT-licensed, packed AuthYard connector (`@authyard/better-auth` 0.3.1) from https://github.com/hashimkarim/authyard, packed by `pnpm connector:pack` from source revision `920fd6ae98dee5d1bd9df6bf1b92bdcf082d3a34` (branch `deps/better-auth-1.7.15`; connector source last changed in `31f44174bd41ade09980590382298ccc4065fdec`).

SHA-256: `eb2c83e091a5ddcb8f5f77967cc19d15b63259cd91daec84a2a8db0f767eae39`.

The package contains its MIT license and requires exact Better Auth 1.7.15 and Node 24+. It is included only for reproducible integration tests: the connector is not yet published to npm, CI must not depend on a mutable sibling checkout, and the SDK package does not redistribute this fixture. Applications install the supported connector from AuthYard and keep their own Better Auth runtime/database. This is not a reimplementation of the connector.

It replaces `@authplane/better-auth` 0.2.0 (Better Auth 1.7.3). The rename and the 1.7.15 upgrade add no connector database migration. The AuthYard control plane must be upgraded before applications adopt 0.3.1, because older control planes reject it.
