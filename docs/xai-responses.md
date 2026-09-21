# xAI Responses adapter

**Unreleased source addition after 0.1.0.** The published
`@agenticdriver/sdk@0.1.0` package uses Chat Completions through `xai()`.
Use a reviewed development build for the new `xaiResponses()` factory. Protocol
fixtures pass; no live xAI account or model has been selected for certification.

xAI's Responses endpoint supports function calls, streamed text and encrypted
reasoning continuation. Its storage defaults to enabled; this adapter explicitly
sends `store: false` and carries the returned output items into later tool steps.
It does not use server-stored response IDs.
[Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses),
[local continuation and storage](https://docs.x.ai/developers/model-capabilities/text/generate-text).

## Configure an explicit API account

```ts
import { AgenticDriver } from "@agenticdriver/sdk";
import { xaiResponses } from "@agenticdriver/sdk/providers";

const driver = new AgenticDriver({
  providers: [
    xaiResponses({
      id: "company-grok",
      apiKey: () => readSecret("company-xai-key"),
      models: [selectedModel],
    }),
  ],
  usage: {
    hostId: "company-driver",
    accounts: { "company-grok": "company-xai-account" },
  },
});
```

`readSecret` and `selectedModel` are supplied by the application. The default
endpoint is `https://api.x.ai/v1/responses`; an operator can configure a different
HTTPS base URL. Model IDs and account bindings are explicit. Catalog discovery
uses the selected endpoint's model route without generation.

For the development host CLI:

```sh
agenticdriver init --config ./driver/config.json \
  --provider xai-responses --provider-id company-grok \
  --account-id company-xai-account --model YOUR_SELECTED_MODEL
```

The default key reference is `XAI_API_KEY`; configuration stores that environment
variable's name, never its value. Existing host configurations can opt in by
changing `kind: "xai"` to `kind: "xai-responses"`. Preserve `id`, `accountId`,
`models` and `apiKeyRef` only while they still refer to the same selected account
and model. Start a new conversation when changing endpoint dialects; private
Chat Completions state is not a Responses continuation record.

The old `xai()` factory and `xai` host kind retain their existing route. There is
no automatic endpoint, provider, model or billing fallback.

## Execution and evidence

- Only selected application function tools are included. Tool arguments still
  pass schema validation, host authorization and approval before execution.
  Provider-hosted search, code execution, remote MCP and other server tools are
  not enabled by this adapter.
- Text deltas stream before the terminal response. Reasoning/tool events can
  report actual progress without exposing reasoning as visible text. Both run
  and inactivity timeouts remain disabled by default; caller cancellation aborts
  the provider request.
- Input, output, cached-input and reasoning token counts map to the existing
  account-scoped usage record when reported. Missing measurements remain unknown.
  Existing Usagestat identity and storage contracts are reused.
- Encrypted reasoning stays private during tool steps and in explicitly enabled
  native sessions. Public results, exported session history and usage records do
  not contain that state.
- HTTP auth/rate failures, provider error events, malformed usage and unfinished
  streams fail through normalized SDK errors. Truncated tool calls do not execute.

The adapter shares the tested Responses parser with OpenAI while keeping its own
vendor, endpoint, usage identity and function declaration format. Its explicit
media policy currently excludes direct PDF input; PDF retrieval can use the
existing ingestion and source-scoped context workflow.

Verification includes stateless tool/state round trips with approval and usage,
private native-session continuation, model discovery, streamed visibility,
caller cancellation, error/truncation behavior, and CLI-created configuration
against a local HTTP fixture. All model results are synthetic. AD-020 remains
open until an explicitly selected xAI account/model passes the live checks.
The Grok Build subscription adapter has separate native isolation requirements.
