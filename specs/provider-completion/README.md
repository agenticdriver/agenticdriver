# Provider completion

Close the original SDK's remaining provider gaps with actual supported native
interfaces and real accounts. Provider construction alone is not acceptance.
The existing four-language clients and transport remain the execution contract.

## Current slices

1. **Gemini catalog route eligibility — implemented.** The API catalog must
   expose only models that support generateContent; explicit host model
   allowlists retain their existing authority. See the discovery tests.
2. **Claude native application tools — implemented; real acceptance pending.**
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
4. **Claude native API billing — implemented; execution acceptance pending.**
   An explicit factory credential or host `apiKeyRef` selects an isolated fresh
   native home, never the subscription profile. API-key authentication and owned
   MCP controls passed with zero model requests on the local pinned runtime.
   Guided setup does not offer this method yet. Direct API-provider acceptance
   remains a separate workstream with its own actual receipts.

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

The selected Prometheus native profile reports signed out; restoring it remains
an account-owner action. A separately selected local API-billed native connection
now passes zero-prompt auth and MCP controls. Finish parent review and build a
fresh combined immutable artifact before the separately authorized bounded
useful tool-result-incorporating native API run. Retain private native receipts
and publish sanitized evidence; do not claim that API billing repaired the
subscription connection. Continue other API/provider acceptance from their own
receipts. Continue native Google/Grok only when their actual controls satisfy the
SDK contract; do not mark blocked provider cells complete.

[Choices](choices.md) record the tradeoffs behind this slice.
