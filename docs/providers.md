# Provider adapters

The selected **Local Antigravity sign-in** is confirmed. Its 1.2.7 headless
initialization still advertises native tools despite the requested empty tool
list, so an Antigravity SDK adapter and live application certification remain
pending. See the [readiness evidence and no-prompt check](validation/antigravity-2026-09-21.md).
This limitation does not require signing in again or switching to API billing.

Documentation reviewed on 2026-09-21. Model IDs are deliberately supplied by the
application or host; this SDK does not silently pick a model or change billing modes.

| Factory                                 | Instance default    | Authentication                          | Application tool loop               |
| --------------------------------------- | ------------------- | --------------------------------------- | ----------------------------------- |
| `openai({ apiKey })`                    | `openai`            | OpenAI API key; Responses API           | Yes                                 |
| `anthropic({ apiKey })`                 | `anthropic`         | Anthropic API key; Messages API         | Yes                                 |
| `gemini({ apiKey })`                    | `gemini`            | Gemini API key; streamGenerateContent   | Yes                                 |
| `xai({ apiKey })`                       | `xai`               | xAI API key; Chat Completions           | Yes                                 |
| `xaiResponses({ apiKey })` (unreleased) | `xai`               | xAI API key; Responses                  | Yes                                 |
| `openaiCompatible({ baseUrl, apiKey })` | `openai-compatible` | Compatible API key                      | Yes, if endpoint supports functions |
| `codex()`                               | `codex`             | Official CLI's existing session         | Text only                           |
| `claudeCode()`                          | `claude-code`       | Official CLI's existing session         | Text only                           |
| `geminiCli()`                           | `gemini-cli`        | Official CLI's cached authentication    | Text only                           |
| `mockProvider()`                        | `mock`              | None; deterministic development fixture | Yes                                 |

An API key may be a string or an async credential resolver, so a host can integrate
a secrets manager. Options also include `id`, `name`, `models`, and an optional
server-owned `baseUrl`. `models` is an allowlist, not just presentation metadata.
CLI options include a trusted `binary` and absolute `accountDirectory`; remote
requests cannot choose binaries, arguments, environment variables, or directories.

Custom local or enterprise integrations can use the [provider extension kit](provider-extensions.md).
It supplies a versioned construction contract, trusted host registration and
fixture checks without changes to the runtime or language clients.

## Subscription mode is provider-specific

Codex supports a ChatGPT sign-in as well as API-key authentication, and OpenAI
documents programmatic SDK integrations. The Codex adapter runs the official
`codex exec --json` command and leaves authentication to that CLI.
[Codex authentication](https://learn.chatgpt.com/docs/auth),
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

Claude Code can run as an unmodified binary with the end user's own sign-in.
Anthropic's documentation distinguishes this from offering Claude.ai sign-in in
a third-party application or routing users' consumer credentials through a
service. Use the API adapter for a conventional hosted Claude product; assess
the official integration requirements for an end-user CLI deployment.
[Claude Code integration and authentication requirements](https://code.claude.com/docs/en/legal-and-compliance).

Gemini CLI documents headless mode and reuse of cached authentication. Its
available quotas depend on the user's authentication method and account.
[Headless mode](https://geminicli.com/docs/cli/headless/),
[authentication](https://geminicli.com/docs/get-started/authentication/).

Live checks on 2026-09-21 found that the selected personal Google sign-in was
rejected as an unsupported client route on Gemini CLI 0.58.0 and the current
stable 0.60.0. The SDK reports `CLI_AUTH_UNSUPPORTED`; it does not infer quota,
subscription tier or successful model access from cached credentials. See the
[recorded validation limits](validation/gemini-cli-2026-09-21.md). Google's
[Antigravity migration guidance](https://antigravity.google/docs/cli/overview/#migrating-from-gemini-cli)
describes a separate route; it is not an automatic fallback in this SDK.

AgenticDriver currently supports Grok through the xAI API. Official Grok Build
headless/ACP and native sign-in interfaces now provide an integration route,
but its SDK adapter and live certification are pending. See the
[dated feasibility decision and implementation work](validation/grok-subscription-2026-09-21.md).
An isolated test of Grok Build 1.0.40 found that setting native inference idle to
zero still terminates after ten seconds of silence. It also attempted separate
session-title generation. These controls need qualification before the SDK can
offer its default disabled-inactivity contract through that native route; the
test used only a synthetic local endpoint, with no account or paid inference.
The published 0.1.0 `xai()` adapter retains Chat Completions. Development source
also offers an explicit `xaiResponses()` factory and `xai-responses` host kind;
see [the unreleased Responses adapter and migration guide](xai-responses.md).
[xAI recommends Responses for new integrations](https://docs.x.ai/developers/model-capabilities/text/comparison).
Both API paths remain separate from the pending Grok Build native-session route.

The normalized mode is called `cli-session`: an existing CLI login may itself use
subscription or API billing. The SDK does not infer the plan, scrape browser
cookies, extract OAuth tokens, or treat subscriptions as universal API credits.

## CLI execution policy

The adapters use an empty temporary working directory, stdin for user content,
an explicit environment allowlist, bounded stdout/stderr, process-group
termination, and runtime feature checks. Ambient application API keys are not
forwarded to a CLI. A host-owned account directory selects a separate account
without copying its credentials.
For Gemini, `accountDirectory` is the home directory containing `.gemini`, as
used by `GEMINI_CLI_HOME`; it is not the `.gemini` directory itself.

- Codex ignores user `config.toml` and execpolicy rule files, requests strict
  configuration validation, disables tools/hooks/apps/MCP, selects the read-only
  sandbox, and uses an ephemeral session. Global `AGENTS.md` instructions and
  skill descriptions can still enter its prompt; these flags do not isolate all
  native context. See the [native Codex checks](validation/codex-2026-09-25.md).
- Claude Code uses restricted mode, safe mode, no tools, strict empty MCP
  configuration, no session persistence, and noninteractive permissions.
- Gemini CLI uses a settings override with an empty effective tool allowlist,
  disabled hooks/extensions/MCP/skills/agents/auto-memory, an empty context configuration, and a
  supplemental deny-tools policy. Host administrators' policies still apply.

These are CLI controls, not an operating-system isolation boundary. Run separate
hosts or OS users/containers for mutually untrusted accounts. `maxOutputTokens`
is passed to API providers; CLI text adapters currently rely on their native
output limits and the SDK's output-byte limit. Inactivity timeouts are optional
and disabled by default for both CLI and API providers.

API adapters request SSE and forward text deltas before a turn completes. Claude
Code runs with `stream-json` and partial messages; Gemini CLI uses `stream-json`.
Codex's `exec --json` progress is item-based, so its capability still advertises
`textStreaming: false` for token streaming. Quiet native reasoning is observable
only when the CLI emits an event. A provider that returns JSON instead of SSE
remains usable, with progress visible only when that response completes.

Gemini startup and streamed failures preserve fixed actionable codes:
`CLI_AUTH_UNSUPPORTED` for the unsupported account route, `CLI_AUTH_REQUIRED`
for recognized missing/expired authentication, `RATE_LIMITED` for recognized
quota/rate failures and `UNSUPPORTED_MODEL` for an unavailable model. Unknown
native failures remain `CLI_FAILED`. Native stderr is privately inspected only
on failed exits, bounded to 64 KiB for classification, and is never copied into
public error messages. CLI JSON result failures are classified before a nonzero
exit can obscure them. These mappings do not add automatic retries.

Codex's recognized native HTTP 401, rate-limit and missing-model diagnostics map
to `CLI_AUTH_REQUIRED`, `RATE_LIMITED` and `UNSUPPORTED_MODEL`. Unknown errors
remain `CLI_FAILED`; native diagnostic bodies and endpoint URLs stay private.
These mappings and the additional Codex options below are development changes
after the published 0.1.0 release.

Set `reasoningEffort` on a Codex provider instance (or its host configuration)
when the application needs an explicit native reasoning setting:

```ts
codex({
  id: "selected-codex",
  models: ["gpt-6-luna"],
  reasoningEffort: "medium",
});
```

The native CLI validates the effort against the selected model. Omitting it
uses the CLI/model default, not the ignored user configuration. This is a
host-owned setting; applications select a configured provider instance rather
than passing arbitrary native configuration in remote requests. Availability
depends on the account and model; the SDK never substitutes another model.

## Provider state and usage

OpenAI Responses output items, Anthropic content blocks, Gemini thought
signatures, and compatible assistant messages stay intact inside a tool loop.
They are not exposed as application data. Refusals, invalid JSON, truncated tool
calls, nonzero CLI exits, and missing terminal markers fail explicitly.

Token totals include cached input; cached-input tokens are also reported as a
subset when available. Gemini API output includes reported thought tokens; Gemini
CLI streaming reports its native output count, with reasoning tokens unavailable. Usage
measurements remain absent when unavailable. Claude CLI's `costUsd`, when
reported, is its API-equivalent estimate and does not establish the amount
charged to a subscription account. Never treat missing cost as zero.

API format references:
[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic API overview](https://platform.claude.com/docs/en/api/overview),
[Gemini generateContent](https://ai.google.dev/api/generate-content),
[Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling).

Streaming format references:
[OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
[Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[xAI streaming](https://docs.x.ai/developers/model-capabilities/text/streaming).
