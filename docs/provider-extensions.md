# Provider extension kit

An application can install its own adapter alongside AgenticDriver without
changing the runtime or any language client. The host imports trusted code;
remote applications select only a configured instance and an enabled model.
Extensions run with the host's privileges. This is a compatibility boundary,
not a JavaScript sandbox or a review of third-party code.

`@agenticdriver/sdk/provider-kit` exports `defineProviderExtension`, its TypeScript
contracts, `ProviderExtensionManifestSchema`, `providerEndpoint` and
`readProviderResponse`. The [manifest JSON Schema](../protocol/provider-extension.schema.json)
is also included in the installed package. These are Node host modules; browser applications continue
to import `@agenticdriver/sdk/client`.

## Construction and registration

The [independent NDJSON adapter](../examples/javascript/custom-provider.mts)
demonstrates credential resolution, a host-owned endpoint, discovery, visible
streaming, tools and private continuation state. The
adapter requires an actual endpoint implementing that protocol. For a standard OpenAI-compatible gateway, use `openaiCompatible` instead.

```ts
import {
  configuredDriver,
  readHostConfig,
  configuredServer,
} from "@agenticdriver/sdk/host";
import { serve } from "@agenticdriver/sdk/server";
import { customProvider } from "./custom-provider.mjs";

const path = "/absolute/path/to/host.json";
const config = await readHostConfig(path);
const driver = configuredDriver(config, path, {
  extensions: new Map([[customProvider.manifest.id, customProvider]]),
});
const server = await serve(driver, await configuredServer(config, path));
// On application shutdown: await server.close().
```

Example operator configuration:

```json
{
  "version": 1,
  "usage": { "hostId": "enterprise-host" },
  "providers": [
    {
      "kind": "extension",
      "id": "company-agent",
      "accountId": "company-account",
      "models": ["YOUR_EXPLICIT_MODEL"],
      "extensionId": "example-ndjson",
      "extensionVersion": "1.0.0",
      "settings": { "endpoint": "https://inference.example/enterprise/" },
      "secretRefs": { "apiKey": { "env": "ENTERPRISE_API_KEY" } }
    }
  ],
  "tokens": [
    {
      "id": "review-app",
      "subject": "review-user",
      "providers": ["company-agent"],
      "tokenRef": { "file": "credentials/review-app.token" }
    }
  ]
}
```

Supply the model, endpoint and credentials for your service. A loopback HTTP
endpoint can replace HTTPS for local development. The example endpoint protocol
is illustrative; it is not an existing provider's API. For an OpenAI-compatible
service, use the existing `openaiCompatible({ baseUrl, models, apiKey })` factory
instead of translating this example protocol.

The registry key, manifest ID and exact extension version must match. An absent
registration, unsupported adapter contract or version mismatch fails with
`PROVIDER_EXTENSION_UNAVAILABLE`. Configuration never imports modules or executes
paths. The stock CLI has no extension registry; use a custom host entry point as
above. Runtime `RunRequest` bodies reject extension/URL/settings fields. Metadata
is application labeling and must never be interpreted as endpoint configuration.

The extension declares its own version and `contractVersion: "1.0"`. Adapter ABI,
HTTP protocol version and SDK package version are separate. Contract 1.0 is the
supported construction/operation shape; breaking changes require a new contract
version. Pin the extension package in the host's dependency lockfile as well as
the version in host configuration. Version matching does not authenticate an
installed package's contents.

## Adapter obligations

The factory receives an instance ID, optional display name, explicit model
allowlist, a validated JSON settings snapshot (at most 128 KB), and an optional
`getSecret(alias, signal)` resolver. Validate your own settings before contacting
an endpoint or reading a credential. `configuredDriver` restricts aliases to that
instance's `secretRefs` and uses the existing host secret resolver; secrets are
not included in discovery, run requests or usage records. Keep secret values out
of settings. The SDK cannot identify arbitrary secrets hidden in custom JSON.

`providerEndpoint` requires HTTPS or loopback HTTP without URL credentials,
query parameters or fragments. It returns a base URL ending with `/`. Keep URLs
in the factory closure and disable redirects on every fetch. Preserve TLS
verification. Do not derive hostnames, credential aliases, binaries or environment
variables from prompts, tool arguments or metadata.

| Operation                    | Contract                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect({ signal })`        | Optional read-only, non-generation probe returning an inspection code and optional model catalog. Discovery filters the catalog against the host allowlist. Return fixed inspection codes; never raw diagnostics.                                           |
| `complete(request, context)` | Translate the explicit model, messages, instructions, selected tool definitions and output-token bound. Return the complete visible text, optional tool calls, measured usage and private state.                                                            |
| `context.emitText(delta)`    | Visible incremental text only. With emitted text, the final turn must contain exactly that accumulated text. Do not emit reasoning or credentials. Declare `textStreaming: true`.                                                                           |
| `context.reportProgress()`   | Real work, such as received function arguments or a completed processing batch. Never a timer, ping or lease heartbeat.                                                                                                                                     |
| `context.signal`             | Forward cancellation to network I/O, credential reads and child processes. Release resources in `finally`. The kit stops awaiting noncooperative implementations and suppresses late callbacks, but cannot stop arbitrary JavaScript or undo a side effect. |
| `turn.toolCalls`             | Declare `tools: true`. Return at most 32 calls with stable nonempty IDs, valid names and JSON object arguments. The runtime validates selected tools and arguments and obtains approval before execution.                                                   |
| `turn.native`                | Bounded JSON opaque to applications. It can preserve provider items/signatures inside a run; cross-run retention requires an explicitly selected native session and `nativeContinuation: true`. Never export it as visible history.                         |
| `turn.usage`                 | Report only known measurements. Missing values remain unknown. Choose accurate `usageSource` provenance; never turn subscription estimates into invoice costs.                                                                                              |

The helper freezes instance models and capabilities, checks the explicit model,
rejects undeclared tools/streaming and validates a bounded (2 MB) result. Inspection
has the runtime's separate discovery timeout. **Runs have no default total or
inactivity timeout.** An application's explicit inactivity policy resets on real
progress.

Unknown exceptions become the runtime's fixed `INTERNAL_ERROR`. A deliberately
thrown `DriverError` is public: use fixed, actionable messages, never upstream
bodies, stderr, stack traces, URLs containing secrets or arbitrary user content.
The kit does not introduce provider/model/account fallback or automatic retries.
Usage identity and the [Usagestat integration](usagestat.md) remain host-owned.
Text/Markdown context and scoped RAG use the ordinary driver request; capabilities
must not imply unimplemented image/PDF or native-agent support.

## Real qualification

Register the extension against its actual service and run meaningful prompts with
an explicitly selected account and inexpensive model. Check discovery, streaming,
cancellation, tools and reported usage individually; unsupported features must be
reported honestly. The simulated `provider-conformance` package entry was removed.
See [real connection verification](real-connections.md).
