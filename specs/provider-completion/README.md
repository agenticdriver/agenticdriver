# Provider completion

Close the original SDK's remaining provider gaps with actual supported native
interfaces and real accounts. Provider construction alone is not acceptance.
The existing four-language clients and transport remain the execution contract.

## Current slices

1. **Gemini catalog route eligibility — implemented.** The API catalog must
   expose only models that support generateContent; explicit host model
   allowlists retain their existing authority. See the discovery tests.
2. **Claude native application tools — implemented; API-mode application run passed.**
   Opt-in Linux x64 Claude Code 2.1.282 uses a private per-turn MCP proposal
   helper. Native proposals are matched to helper confirmations, then the native
   process is interrupted/reaped before SDK validation, approval and application
   effects. Text mode remains the default. Only the ordinary SDK tool pipeline
   executes callbacks. Portable continuation includes calls, IDs and results;
   it does not resume a private Claude session.
3. **Current native Google/Grok routes — actual blockers.** Antigravity 1.5.1
   still advertises 60 tools under an empty custom agent. Grok 1.0.70 has no
   established supported disabled-idle contract. A stale test result must not
   stand in for current runtime qualification. Preserve actual account selection;
   do not silently switch to API billing.
4. **Claude native API billing — implemented; installed application run passed.**
   An explicit factory credential or host `apiKeyRef` selects an isolated fresh
   native home, never the subscription profile. API-key authentication and owned
   MCP controls passed before the separately recorded real installed run.
   Guided setup offers these credential choices. Direct API-provider acceptance
   has separate receipts and content-review limits.

## Authority and verification

Claude's blanket safe mode suppresses explicit MCP too. Tool opt-in uses native
restricted mode, no user/project/local setting sources, no built-in tools,
strict one-server MCP configuration, no slash commands or Chrome, no permission
prompts, and settings disabling hooks, memory and fallback. The exact owned
initialization inventory must match before proposals are accepted. Managed host
policy remains authoritative; these controls are not an OS tenant boundary.

A zero-prompt native check first verifies sign-in, current model catalog and
owned MCP status. Project hook/MCP canaries must not run. A meaningful real
run then reads a public release note through a selected application tool and
uses its result in an email draft, with exact provider/model/billing and usage.
Use one SDK run with at most two model steps; do not retry accepted/uncertain
work. Protocol tests exercise records and actual local proposal IPC, never a
fake successful provider or fabricated model completion.

## Next pickup

The installed immutable candidate completed a real Claude Code API-mode brand
workflow with one approval/callback and two native steps. OpenAI and direct
Anthropic API tool/approval/streaming/usage checks passed from published clients
in all four languages; Anthropic content acceptance remains partial. See the
[API evidence](../../docs/validation/api-tools-2026-11-05.md) and
[native evidence](../../docs/validation/claude-tools-2026-11-05.md).

The selected Prometheus subscription profile remains signed out. Active provider cancellation/real denial qualification, broader
platform qualification and consumer upgrades remain separate work. Continue
native Google/Grok only when their actual controls satisfy the SDK contract;
Gemini/xAI API execution still needs an available explicitly selected credential.
This development pass is not a release or complete consuming-app acceptance.

[Choices](choices.md) record the tradeoffs behind this slice.

## Current follow-up

Credential-resolution cancellation is covered for API execution and discovery.
Installed multi-language package and pure contract checks passed against the
consolidated working checkout, including Rust 1.89 feature combinations. Fresh
npm installation and private SQLite lifecycle checks passed on the host filesystem.
The 2026-11-06 real denial/active-cancellation attempt lost its observations to a
receipt-storage quota failure and was not retried; its outcomes remain unknown.
Future real qualifiers must persist request boundaries before proceeding. Native
Antigravity/Grok upstream controls remain blockers after current read-only checks.
The installed Antigravity 1.4.4 check still advertised 60 tools without a prompt;
the latest 1.5.1 archive matched the prior recorded hash, but a new extraction
failed under temporary storage pressure and was not counted as execution.
Grok's reviewed source revision remains unchanged. Private research receipt
SHA-256: `9c50cbbe5cc5afb71b664619ec70e5f54485394557b891b18ef71c3fe67d6411`.

## Local Antigravity execution

A separately authorized direct CLI brand run succeeded with the existing native
profile and exact `gemini-3.8-flash-low`, with reported usage and no observed tool
calls. The same installed binary subsequently passed model/agent/strict selection
but still advertised 60 tools in the SDK readiness probe. This closes the local
model-execution unknown; SDK adapter enforcement remains open. See the
[actual local evidence](../../docs/validation/antigravity-local-2026-11-06.md).
