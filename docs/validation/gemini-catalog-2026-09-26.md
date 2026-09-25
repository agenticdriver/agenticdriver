# Gemini native catalog boundary — 2026-09-26

Gemini CLI **0.58.0 on Linux x64** has an official ACP model inventory, but its
subscription startup does not provide the noninteractive, metadata-only failure
behavior required by AgenticDriver discovery. The SDK retains
`CLI_STATUS_UNKNOWN` and an explicitly incomplete configured inventory. No
subscription credential is copied or converted to an API connection.

The [official ACP interface](https://geminicli.com/docs/cli/acp-mode/) uses stdio
JSON-RPC. The installed implementation returns `models.availableModels` from
`session/new`, after authentication and session initialization. The fixture sent
only `initialize` and `session/new`; it never sent `session/prompt`, an
authentication request, a command or a tool response.

In an isolated process with a synthetic API credential, that interface reported
six IDs, including the native `auto` alias. This proves the protocol shape only.
It does not establish a real account's inventory, entitlement, selected model,
pricing or successful generation. The SDK does not select the alias or copy this
fixture's list into a production catalog.

The same executable with an empty OAuth account directory entered manual
authorization **before receiving any protocol input**. `NO_BROWSER=1` prevented
browser launch but still produced an authorization-code prompt. Source inspection
confirmed that ACP is considered interactive and startup authentication precedes
the ACP dispatcher. A queued protocol request could consequently become input
to that login dialog. A discovery timeout would only stop the resulting flow;
it would not make starting it an acceptable read-only check. This is distinct
from the previously observed Google rejection of the selected personal route.

The reproducible fixture hides the real home and system configuration, disables
external networking, supplies no real credentials, and seeds ambient hooks/MCP
launch markers. Its temporary policy disables tools, hooks, extensions, agents,
skills, automatic memory and the local Gemma router. Neither marker ran. The
missing-login case sends zero stdin bytes and terminates as soon as the native
authorization UI is detected. These temporary controls do not modify the user's
installation or account configuration.

```sh
npm run test:gemini-catalog-native -- \
  --package /absolute/path/to/node_modules/@google/gemini-cli \
  --receipt /private/path/gemini-catalog.json
```

The command requires Linux and Bubblewrap and is pinned to 0.58.0. It reports
`passed: true` when it reproduces both observations, alongside
`subscriptionCatalogProbeQualified: false`. A passing fixture is therefore
**evidence of the limitation**, not SDK activation or account certification. Its
watchdog bounds test infrastructure only. Native JavaScript bundle identity:
SHA-256 `2ad8c592e8296435c8eb82f884aa59169e820d5434607f98cb72f4aae32bbf92`,
computed over 72 sorted bundle filenames and their individual SHA-256 digests.

[Gemini certification issue #23](https://github.com/agenticdriver/agenticdriver/issues/23)
owns the remaining supported account route and metadata qualification. Enable
the native probe only after an official fail-without-login interface, or another
qualified metadata interface, avoids this interactive startup. It must keep
account isolation, bounded replies, refresh cancellation separate from active
runs, and no model/account/billing fallback. API-mode Gemini already has a
separate supported model-list endpoint; it is not a fallback for this connection.
