# Provider connection design

Reviewed on 2026-09-26 after the initial provider panel, management API and host
pairing shipped on `sdk-roadmap`. This records the next implementation work;
items explicitly marked planned are not available in the original registry 0.1.0.

[AD-053 / #49](https://github.com/agenticdriver/agenticdriver/issues/49) implements
the first slice on `sdk-roadmap`: host-reported provider definitions, typed metadata
in all four languages, and a searchable shared setup component for existing
native sign-ins, API keys, host secret references and compatible endpoints.
[AD-054 / #50](https://github.com/agenticdriver/agenticdriver/issues/50) owns the
[owned native device sign-in lifecycle](provider-sign-in.md), initially qualified for Codex.

## Reference review

| Reference                                                                                                                                                                                                                                                                                                                    | Observed connection pattern                                                                                                                                                                                       | AgenticDriver decision                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [T3 Code provider setup](https://github.com/pingdotgg/t3code/blob/295d7cba09bb4b4084482a74b5a42a0cac72a0b1/packages/contracts/src/providerSetup.ts) and [flow ownership](https://github.com/pingdotgg/t3code/blob/295d7cba09bb4b4084482a74b5a42a0cac72a0b1/apps/server/src/provider/ProviderAuthFlow.ts)                     | Select an environment and a provider instance; discover sign-in methods; represent browser, device-code, terminal or credential interaction as an owned setup operation. Native adapters own credential handling. | Make the selected host, account and supported connection methods explicit. Bind setup attempts to an authorized caller and configuration revision. Discovery must never start sign-in.                                                              |
| [OpenCode connection UI](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/app/src/components/dialog-connect-provider.tsx) and [integration API](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/protocol/src/groups/integration.ts) | A searchable provider picker leads to advertised key/OAuth methods, inputs and cancellable attempts. Integration metadata is separate from credentials and model use.                                             | Add a provider catalog and guided connection flow to the shared component and all language clients. Keep adapters responsible for provider-specific details.                                                                                        |
| [LLMRouter](https://github.com/ulab-uiuc/LLMRouter/blob/d1490a37202b1bea799ab3a601cab349d2291b08/README.md) and [API calling](https://github.com/ulab-uiuc/LLMRouter/blob/d1490a37202b1bea799ab3a601cab349d2291b08/llmrouter/utils/api_calling.py)                                                                           | Model candidates carry service and endpoint identity. Inference utilities use LiteLLM and service-specific key pools; routing chooses destinations and can rotate keys.                                           | Keep endpoint, account and model identity explicit. Routing is a separate application decision; connecting a provider must not enable key rotation or destination fallback.                                                                         |
| [llm-proxy configuration](https://github.com/llm-proxy/llm-proxy/blob/fb588f614adfd1cb96f467f9f40f60f31fc5a47f/llmproxy.config.yml) and [adapter setup](https://github.com/llm-proxy/llm-proxy/blob/fb588f614adfd1cb96f467f9f40f60f31fc5a47f/proxyllm/proxyllm.py)                                                           | Named providers use environment-key references and configured model pools behind shared adapters. Cost/category routing belongs to the proxy.                                                                     | Reuse AgenticDriver's secret references and adapter contracts. Preserve account-reported catalogs rather than substituting a static routing pool.                                                                                                   |
| [Vercel AI Gateway BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok) and [provider routing](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)                                                                                                                                   | Managed credentials, provider toggles, model mappings and an explicit small inference test. Gateway routing and billing policies can select alternate credentials/providers.                                      | Offer gateway connections as an explicit endpoint/protocol/account choice. Metadata refresh and paid qualification are separate actions. A gateway's own fallback policy must be disclosed and qualified before claiming a pinned upstream account. |
| [Orq's proxy/gateway/router guide](https://orq.ai/blog/what-is-llm-proxy)                                                                                                                                                                                                                                                    | Connection management, destination selection and broader policy/observability serve different responsibilities. A model-request proxy alone does not capture the complete agent workflow.                         | Keep provider setup independent of application workflows, model routing and tool/RAG execution. The host supplies a reusable connection layer to all three applications.                                                                            |
| [Langfuse LLM connections](https://langfuse.com/docs/administration/llm-connection) and [OpenTelemetry ingestion](https://langfuse.com/integrations/native/opentelemetry)                                                                                                                                                    | Named API connections expose adapter, endpoint and custom-model settings for playground/evaluation calls. Call options live with the workload. Tracing accepts OTel independently of inference.                   | Use named API/gateway connections with explicit protocol and model inventories. Integrate optional tracing through the existing OTel bridge; Usagestat remains the usage backend.                                                                   |

These projects were inspected as references. Their implementations, credentials,
provider catalogs and runtimes are not copied into AgenticDriver. A technique in
another product is not evidence that an SDK provider/version or subscription
deployment is supported.

## Connection model

Applications connect to an **execution host**, locally or remotely. On that host,
a **provider kind** describes an integration, while a **provider instance** owns
one stable configuration/account identity. The instance exposes its reported
models and supported setup methods. The application separately holds a scoped
host connection credential. Provider credentials stay on the execution host.

The existing IDs, `accountId`, secret references, host invitations, revisioned
management and model catalog remain the foundation. New setup metadata extends
those contracts rather than creating another provider runtime or identity system.

The intended user flow is:

1. Connect to or start a host. Show which machine owns the providers and paths.
2. Choose a provider from a searchable catalog, then select a supported method:
   existing native sign-in, provider-owned browser/device flow, API key or an
   explicitly configured compatible endpoint.
3. Complete setup. Show waiting, verification, success, failure and cancellation
   states without exposing stored credentials. Runtime/version requirements and
   unsupported methods are visible before starting.
4. Refresh all reported models without inference. Keep permissions, enabled state,
   device preferences and dated live qualification distinct.
5. Optionally perform a small, explicitly selected model test. Record its exact
   account/model and usage; a successful test qualifies only that combination.

The initial panel already supports host pairing, provider settings, write-only API
keys, model refresh and local preferences. Its missing piece is a provider setup
lifecycle: a blank settings form or a CLI command alone is not the completed flow.

## Setup contracts to implement

**Provider definitions** describe the methods and fields the installed host
supports. They include human labels, transport/billing mode, setup help and runtime
requirements. They are not an account entitlement catalog. Unsupported kinds can
be explained in onboarding without advertising an executable adapter.

**Setup attempts** have an opaque ID, provider/account/configuration binding,
initiating caller, method, phase and optional interaction. API keys are write-only.
Browser/device interactions carry only the information needed by their owner.
Successful callback delivery is not proof of completed native authentication.
Adapters verify completion before publishing success and refreshing models.

Native credential exchange and refresh remain with official supported runtimes.
Methods that cannot be implemented through a qualified interface give actionable
external setup instructions. Do not extract subscription tokens or present a
third-party implementation as provider approval. Setup expiry and one-use codes
are credential-lifecycle controls; they do not impose inference deadlines.

Setup attempts must reject stale configuration, conflicting account changes and
cross-caller access. Refreshing metadata never cancels a run. Credential replacement
must preserve a running request's account binding: use a new private account/profile
for new sign-in, or reject replacement while the affected identity is active.
Never silently sign out or overwrite a shared CLI account.

TypeScript, Python, Go and Rust expose the same operations. The single shared web
component renders advertised methods instead of hardcoding separate provider
flows per application. Existing hosts/clients retain their current contracts;
unsupported setup operations remain unavailable through feature negotiation.

## API and gateway connections

Represent the selected upstream protocol separately from branding: OpenAI Chat
Completions, OpenAI Responses, Anthropic Messages or Gemini. Endpoint, credential
reference, account identity and model overrides belong to the connection. Workload
parameters belong to the run, subject to host policy. Custom model IDs are permitted
without being marked discovered or tested.

Gateway support must account for upstream behavior. For example, Vercel's documented
BYOK mode can retry with system credentials billed to gateway credits. Sending a
single request to a gateway does not by itself establish a no-fallback guarantee.
An explicitly selected gateway identity remains distinct from a direct provider
account. AgenticDriver will not enable cross-account/model/billing fallback as a
side effect of this connection work.

## Local and remote setup

Keep direct HTTPS pairing and private backend credentials. Improve the local
bootstrap so starting the host and opening its provider setup does not require
manually assembling multiple processes and configuration files.

A hosted application cannot reach a user's laptop by calling its own loopback
address. Remote onboarding must explain the reachable path and offer supported
direct TLS or a separately implemented outbound connection service. T3's
[pairing, SSH and relay options](https://github.com/pingdotgg/t3code/blob/295d7cba09bb4b4084482a74b5a42a0cac72a0b1/docs/user/remote-access.md)
are useful UX references. The existing outbound-relay roadmap item remains a
separate implementation; a pairing invitation does not create a network tunnel.

## Observability and application ownership

Use existing Usagestat identities, usage capture and provider assets. Langfuse can
consume optional OTel run/model/tool/retrieval spans through an application-owned
exporter. Connecting a provider does not send prompts, emails, papers or tool
payloads to an observability service. Any richer payload export is a separate,
explicit application decision.

Brandstorm, LitAgent and AI Workspace consume these SDK contracts. They retain
their workflows, authentication, settings authorization and per-connection
enablement. No application auth migration or parallel provider runtime is needed.
