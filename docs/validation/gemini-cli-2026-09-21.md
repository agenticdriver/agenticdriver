# Gemini CLI validation: 2026-09-21

**Live certification is incomplete.** The selected local personal Google sign-in
is rejected by the upstream service before model text is produced. Fixture
success must not be presented as a successful live subscription integration.

| Check                   | Evidence                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-selected route     | Existing local Gemini personal Google sign-in; no credential export or new login.                                                                                |
| Explicit model          | `gemini-2.5-flash`, one synthetic text request per attempt.                                                                                                      |
| Installed CLI           | 0.58.0: upstream rejects the client route; no visible model text.                                                                                                |
| Current stable CLI      | 0.60.0, installed separately for verification: same rejection, now normalized as `CLI_AUTH_UNSUPPORTED`.                                                         |
| SDK stream              | `run.started`, `step.started`, `run.failed`; no successful completion or token delta.                                                                            |
| Usage                   | No reported token/cost measurements. Unknown remains unknown.                                                                                                    |
| Local regression checks | Startup diagnostics, streamed quota errors, missing/expired-auth classifications, generic error redaction, restricted settings and successful synthetic streams. |
| Still pending           | Live successful text/structured output, active model progress/cancellation, quota/account behavior and full ambient-configuration isolation certification.       |

The service requests migration to Antigravity. This is an observed account-route
rejection, not evidence that an account has exhausted quota or belongs to a
particular subscription tier. Updating from 0.58.0 to 0.60.0 did not make this
account route usable. No alternate billing mode, model or provider was invoked.
The installed global CLI and existing account configuration were preserved.

The SDK now distinguishes this failure from `CLI_FAILED`. Recognized quota,
missing/expired-authentication and unavailable-model conditions have their own
fixed errors, with no credential/account details or raw stderr in responses.
It explicitly disables native agents, auto-memory and model steering alongside
the existing tool/hook/extension/MCP/skill restrictions. Tests assert the settings
passed to a fixture executable; that does not certify every native feature.

Applications can surface the unsupported route and ask the operator to select a
supported account path. Brandstorm and literature-review live acceptance remain
pending; AI Workspace has authorized only an isolated synthetic adapter harness,
not real-mailbox actions or UI/backend integration.

Sources reviewed on the validation date:

- [Official stable release 0.60.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.60.0).
- [Gemini cached authentication in headless mode](https://geminicli.com/docs/get-started/authentication/#running-in-headless-mode).
- [Gemini headless output and exits](https://geminicli.com/docs/cli/headless/).
- [Settings precedence](https://geminicli.com/docs/reference/configuration/#configuration-layers) and [supplemental policy rules](https://geminicli.com/docs/reference/policy-engine/).
- [Google's Antigravity migration guidance](https://antigravity.google/docs/cli/overview/#migrating-from-gemini-cli).

Only synthetic prompts were used. Account identifiers, credentials, private
diagnostics and CLI session IDs are excluded from this record.
