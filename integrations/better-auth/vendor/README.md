# AuthYard contract-test dependency

`authplane-better-auth-0.2.0.tgz` is the actual MIT-licensed, packed AuthYard connector from https://github.com/hashimkarim/authyard at source revision `0b9a3ccb9fa5993c91f02e0684d8d7caa8cdcc56`.

SHA-256: `4df6857225eb9a34502716ee58883392b090950a4d3651256ed5c8f371ac5bc6`.

The package contains its MIT license and requires exact Better Auth 1.7.3 and Node 24+. It is included only for reproducible integration tests: the connector is not yet published to npm, CI must not depend on a mutable sibling checkout, and the SDK package does not redistribute this fixture. Applications install the supported connector from AuthYard and keep their own Better Auth runtime/database. This is not a reimplementation of the connector.

AuthYard has an in-progress package rename to `@authyard/better-auth` 0.3.0. Update this fixture only after the corresponding source revision and packed artifact are committed and verified, following AuthYard's control-plane-first migration instructions.
