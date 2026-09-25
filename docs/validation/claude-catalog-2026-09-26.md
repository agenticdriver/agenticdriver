# Claude native model metadata — 2026-09-26

Development source qualifies the metadata interface of **Claude Code 2.1.282 on
Linux x64**. Native executable SHA-256:
`3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3`.
This work submits no inference request and does not certify model execution.

The official TypeScript Agent SDK 0.3.282 exposes `supportedModels()` through its
initialization response. Its `ModelInfo` contains a `value` and optional
`resolvedModel`. The SDK package was reviewed from its integrity-verified npm
distribution; the native stdio control message was independently exercised.
[Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[versioned package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282).

After the official `auth status` check succeeds, AgenticDriver launches a separate
process in an empty temporary directory. Restricted/safe modes, empty tools and
MCP configuration, disabled hooks/memory, noninteractive permissions and disabled
session persistence remain in force. The only input is an `initialize` control
request with empty hooks and SDK MCP servers. The probe closes stdin after its
matching response and reaps the process. It does not supply a model or user text.
Native administrator policies remain authoritative.

Both aliases and resolved IDs are included without guessing unreported models.
For example, a native API-mode fixture reported an alias `opus[1m]` and its
canonical context-window variant. A synthetic subscription fixture instead
reported eight unique identifiers without that variant. That difference is why
the SDK reads the selected instance rather than copying another account's list.
Aliases remain explicit choices; discovery never chooses one or starts a run.

Catalog health stays `unknown`/`CLI_CATALOG_AVAILABLE`. The complete, nonpaged
native reply does not prove that its cached/bundled entries are currently enabled
for the account. `complete` describes collection of that reply, with a 1,000-ID
limit and explicit truncation. Responses are bounded to 2 MB and native rows to
10,000. Unknown versions keep the prior saved-login/configured-inventory result.
Malformed messages, unexpected authority requests and mismatched request IDs fail
without publishing raw native diagnostics or account details.

Model IDs retain their literal square-bracket suffixes through host overrides,
run/session schemas, all language clients and the provider panel. Older clients
can display catalogs, but their session or embedding validators may reject these
IDs; use the updated source package for context-window model selection. Registry 0.1.0 predates
this validation change and the new provider panel.

The isolated native fixture hides the real home, uses only synthetic OAuth data,
disables external networking and seeds ambient hooks/MCP launch markers. It
verified signed-in versus signed-out behavior, unchanged deny-all execution
permissions, the native catalog, no hook/MCP startup and process shutdown. The
protocol fixture separately checks two accounts, aliases/context variants,
deduplication, truncation, malformed/authority messages, unknown versions, denied
models, and metadata refresh while a generation fixture remains active.

```sh
npm run test:claude-catalog-native -- --binary /absolute/path/to/native/claude
```

The native fixture requires Linux and Bubblewrap. Its watchdog bounds test
infrastructure only; no default run or inactivity deadline is added. After the fixture passed, the selected local sign-in reported eight aliases and
resolved IDs through the same probe, with no prompt submitted. Its deny-all test
allowlist remained unchanged. That metadata observation does not establish
pricing, quotas, live generation, or cross-platform native support.

For subsequent explicit model runs, the native settings now set an empty
`fallbackModel` and `switchModelsOnFlag: false`. In noninteractive execution this
preserves a refusal instead of silently switching models. These settings neither
relax a provider refusal nor bypass administrator policy.
[Official fallback behavior](https://code.claude.com/docs/en/model-config#automatic-model-fallback).
