# Provider, model and account discovery

`GET /v1/providers` checks only the provider instances authorized by the caller's
driver token. Each instance keeps its own ID, credential resolver, cache and model
allowlist. Two OpenAI accounts, for example, remain separate instances such as
`openai-personal` and `openai-work`. The response never includes credentials,
account emails, CLI paths, raw provider errors or CLI output.

The embedded driver exposes `await driver.discoverProviders()`. Its optional
`providers` filter is for trusted hosts to apply their authorization policy;
embedded access itself is trusted. The existing synchronous
`driver.listProviders()` returns static configuration without running probes.

## Refresh and caching

Clients can request a refresh:

| Client                  | Call                                        |
| ----------------------- | ------------------------------------------- |
| TypeScript / JavaScript | `await client.providers({ refresh: true })` |
| Python                  | `client.providers(refresh=True)`            |
| Go                      | `client.RefreshProviders(ctx)`              |
| Rust                    | `client.refresh_providers()`                |
| HTTP                    | `GET /v1/providers?refresh=true`            |

The host advertises `provider-discovery` in `/v1/protocol`. Older hosts may omit
health/catalog fields or reject the refresh query; clients do not silently retry
against another host or account.

Each instance caches its latest result for 30 seconds, including failures.
Explicit refresh bypasses that lifetime but respects a one-second minimum
interval. Overlapping checks share the same probe. Timestamps show when the
cached check completed; there is no background polling. Replacing a credential
returned by an API key resolver takes effect on the next probe or model call.

Host options can change these defaults:

```ts
const driver = new AgenticDriver({
  providers,
  discovery: { cacheTtlMs: 30_000, minRefreshMs: 1000, timeoutMs: 5000 },
});
```

The five-second bound applies only to discovery. It does not add a model-run
deadline or enable the optional inactivity timeout. Cancelling an embedded
discovery reader stops that reader's wait; a shared probe continues within its
own bound for other readers. Custom adapters must honor the probe's abort signal.

## Interpreting results

`health` contains `status`, `code`, a fixed public `message`, and `checkedAt`.

| Status            | Meaning                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ready`           | An authenticated API catalog request succeeded; execution, billing and quota remain untested.                       |
| `unauthenticated` | An API key is missing/rejected, or an official CLI status command reports no login.                                 |
| `unavailable`     | A connection, timeout, rate limit, executable or response-format problem prevented the check.                       |
| `unsupported`     | The catalog route, credential permissions, adapter probe or required CLI execution features are unavailable.        |
| `unknown`         | CLI features are present, but a saved login or an inconclusive status check cannot establish current remote access. |

Health is advisory. A failure never selects another provider, account, billing
mode or model. It does not prevent trying an explicitly selected, allowed model
after credentials change. Required run capabilities still fail before execution
when the adapter does not advertise support.

`models` retains its original meaning: the host's exact model allowlist. An
omitted allowlist permits any explicit model ID, subject to the provider accepting
it. A discovered catalog never broadens this permission.

`modelCatalog` contains `source`, `models` and `complete`. On successful discovery,
its source is `provider` and its IDs are filtered against the allowlist. On a
failed or unsupported probe, its source is `configured` when an allowlist exists,
otherwise `unavailable`. Those inventories are unverified and `complete` is false.
The old successful inventory is not presented as current after a failed refresh.
Aliases missing from the vendor catalog remain usable when explicitly allowed.

API catalogs are bounded to 1000 unique model IDs, 20 pages and 2 MB of response
data in total. A page/model limit produces `complete: false`; malformed responses
and repeated pagination cursors produce an unavailable status. OpenAI and xAI
catalogs can include models for other API operations; a catalog entry alone does
not certify compatibility with text generation or every adapter capability.
Gemini entries are limited to models advertising `generateContent`.

## Probe sources and limitations

API probes issue only GET requests against the host-configured endpoint and
disable redirects. Pagination follows the documented model-list cursors. Routes:
[OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list),
[Anthropic models](https://platform.claude.com/docs/en/api/models/list),
[Gemini models](https://ai.google.dev/api/models), and
[xAI models](https://docs.x.ai/developers/rest-api-reference/inference/models).
Compatible endpoints use the same GET `models` route; an unsupported route is
reported without trying generation as a substitute.

CLI probes run feature help and supported status commands in an empty temporary
working directory using the configured account directory and restricted
environment. [Codex `login status`](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [Claude Code `auth status`](https://code.claude.com/docs/en/cli-reference)
report local login state. A zero exit status becomes `CLI_SESSION_PRESENT` with
unknown health; it does not prove that a saved credential is unexpired. A login
failure is actionable through the CLI's official sign-in flow. Gemini's documented
[`/auth` command](https://geminicli.com/docs/reference/commands/#auth) opens an
interactive dialog, so this adapter reports `CLI_STATUS_UNKNOWN` after checking
features. It does not scrape credentials or start an interactive session.

All probes avoid model generation. Live account/model certification is tracked
separately for each provider; fixture tests do not establish vendor account access.
