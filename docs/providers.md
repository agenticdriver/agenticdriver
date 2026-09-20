# Provider adapters

Documentation reviewed on 2026-09-20. Model IDs are deliberately supplied by the
application or host; this SDK does not silently pick a model or change billing modes.

| Factory                                 | Instance default    | Authentication                          | Application tool loop               |
| --------------------------------------- | ------------------- | --------------------------------------- | ----------------------------------- |
| `openai({ apiKey })`                    | `openai`            | OpenAI API key; Responses API           | Yes                                 |
| `anthropic({ apiKey })`                 | `anthropic`         | Anthropic API key; Messages API         | Yes                                 |
| `gemini({ apiKey })`                    | `gemini`            | Gemini API key; streamGenerateContent   | Yes                                 |
| `xai({ apiKey })`                       | `xai`               | xAI API key; Chat Completions           | Yes                                 |
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

Grok is supported through the xAI API. A Grok subscription bridge is not
implemented. xAI documents Chat Completions as supported but legacy; the adapter
uses that established function-calling contract, and a native Responses adapter
can be added separately.
[xAI Chat Completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions).

The normalized mode is called `cli-session`: an existing CLI login may itself use
subscription or API billing. The SDK does not infer the plan, scrape browser
cookies, extract OAuth tokens, or treat subscriptions as universal API credits.

## CLI execution policy

The adapters use an empty temporary working directory, stdin for user content,
an explicit environment allowlist, bounded stdout/stderr, process-group
termination, and runtime feature checks. Ambient application API keys are not
forwarded to a CLI. A host-owned account directory selects a separate account
without copying its credentials.

- Codex ignores user configuration, disables tools/hooks/apps/MCP, selects the
  read-only sandbox, and uses an ephemeral session.
- Claude Code uses restricted mode, safe mode, no tools, strict empty MCP
  configuration, no session persistence, and noninteractive permissions.
- Gemini CLI uses a settings override with an empty effective tool allowlist,
  disabled hooks/extensions/MCP/skills, an empty context configuration, and a
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
