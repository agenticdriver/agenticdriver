# Provider extension kit

An application can install its own adapter alongside AgenticDriver without
changing the runtime or any language client. The host imports trusted code;
remote applications select only a configured instance and an enabled model.
Extensions run with the host's privileges. This is a compatibility boundary,
not a JavaScript sandbox or a review of third-party code.

`agenticdriver/provider-kit` exports `defineProviderExtension`, its TypeScript
contracts, `ProviderExtensionManifestSchema`, `providerEndpoint` and
`readProviderResponse`. `agenticdriver/provider-conformance` exports synthetic
compatibility checks. The [manifest JSON Schema](../protocol/provider-extension.schema.json)
is also included in the installed package. Both are Node host modules; browser applications continue
to import `agenticdriver/client`.

## Construction and registration

The [independent NDJSON adapter](../examples/javascript/custom-provider.mts)
demonstrates credential resolution, a host-owned endpoint, discovery, visible
streaming, tools and private continuation state. The
[runnable fixture host](../examples/javascript/provider-extension.mts) tests it
against a local synthetic service. These examples import only installed public
package exports. `npm run test:install` compiles and runs them outside this checkout.

```ts
import {
  configuredDriver,
  readHostConfig,
  configuredServer,
} from "agenticdriver/host";
import { serve } from "agenticdriver/server";
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
progress. The conformance runner's deadline bounds a test, not an application run.

Unknown exceptions become the runtime's fixed `INTERNAL_ERROR`. A deliberately
thrown `DriverError` is public: use fixed, actionable messages, never upstream
bodies, stderr, stack traces, URLs containing secrets or arbitrary user content.
The kit does not introduce provider/model/account fallback or automatic retries.
Usage identity and the [Usagestat integration](usagestat.md) remain host-owned.
Text/Markdown context and scoped RAG use the ordinary driver request; capabilities
must not imply unimplemented image/PDF or native-agent support.

## Compatibility tests

```ts
import { testProviderConformance } from "agenticdriver/provider-conformance";
const report = await testProviderConformance({
  mode: "fixture",
  model: "fixture-model",
  create: (scenario, { signal }) => makeSyntheticAdapter(scenario, signal),
});
```

The factory must use synthetic responses and enable the fixture model. Each
scenario gets a fresh adapter and a test cancellation signal. A bounded test
timeout defaults to five seconds per scenario, including factory construction.
Supply a longer `testTimeoutMs` for slow test infrastructure. Factory resources
must honor their signal, which is aborted when the scenario ends.

| Scenario/input              | Synthetic response                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conformance:text`          | `Hello fixture`, with no usage measurements; stream it if supported.                                                                                                                  |
| `conformance:structured`    | `{"ok":true}`, satisfying the requested JSON Schema.                                                                                                                                  |
| `conformance:tools`         | One `conformance_lookup` call with `{ "value": 7 }`; consume the tool's `{ "receipt": 7 }` and finish with `tool receipt: 7`.                                                         |
| `conformance:private-error` | Fail using a private body/exception containing `conformance-secret-marker`; it must not appear in public events.                                                                      |
| `conformance:cancel`        | Report real fixture readiness with `reportProgress`, then remain pending until cancellation.                                                                                          |
| `conformance:native`        | `first visible reply` and private JSON containing `private-state-marker`; on `conformance:native-followup`, verify the private state was retained and return `native state received`. |

The report lists passed checks and explicitly skipped unsupported tools/native
continuation. Assertions check event sequence, terminal behavior, unknown usage,
one tool effect, structured output, cancellation and private-state redaction.
Verify upstream cancellation/resource release in the adapter's own tests; a
cancelled runtime result alone does not prove the underlying operation stopped.

The installed NDJSON example passes all six scenarios and verifies upstream
disconnect, restricted model discovery and rejection of remote endpoint changes.
The shared HTTP/verified-HTTPS harness uses a separate versioned fixture extension
through the kit for TypeScript, Python, Go and Rust, including sessions, tools,
RAG and jobs. `npm run check`, `npm run test:clients` and `npm run test:install`
cover these layers. Fixture results do not certify live accounts, costs, native
process isolation or third-party package security.
