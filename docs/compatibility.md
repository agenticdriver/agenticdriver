# Compatibility and qualification

| Component            | Runtime contract                                      |
| -------------------- | ----------------------------------------------------- |
| Node.js SDK and host | Node.js 22.13 or later; ESM                           |
| Python client        | Python 3.10 or later; async support is optional       |
| Go client            | Go 1.22 or later                                      |
| Rust client          | Rust 1.89 or later; blocking and async features       |
| Desktop              | Packaged Linux x64 preview, bundled Node and Electron |

Prometheus CI checks the declared minimum runtimes, Node 24 and Node 26, the
portable provider component, language package installation and documentation.
It runs pure validation/process checks and builds; it does not invent an account
or return canned model responses. macOS and Windows execution need their own
qualification. Earlier release reports describe their historical test scope.

```sh
npm ci
npm run check
npm run protocol
npm run test:package
npm run test:clients
```

These checks do not consume provider allowance and are not live model certification.
For inference, [connect a real account](real-connections.md), explicitly select an
available inexpensive model and run the real application prompts. The recorded
Prometheus route uses qualified Codex 0.157.0 and Claude Code 2.1.282 binaries;
account-reported availability of other models does not mark them tested.

A provider-specific API or native adapter being present is not proof that every
account, CLI version, OS, tool mode or modality works. Unsupported native controls
must fail closed; there is no provider/account/model or billing fallback.
See [native restrictions](native-tools.md), [provider discovery](discovery.md),
and [current real evidence](validation/prometheus-real-2026-09-28.md).
