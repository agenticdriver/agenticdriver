# Troubleshooting

Start with the boundary that failed. Keep tokens, prompts, document contents and
raw provider error bodies out of shared logs. Optional [diagnostics](diagnostics.md)
report stable codes and bounded metadata without becoming a second usage store.

| Symptom                                     | Check                                                                                                        | Next action                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                              | Current driver credential, Better Auth issuer/resource, native expiry/revocation and the app's current grant | Obtain a current app credential or repair the explicit service/device grant; do not substitute a provider API key |
| `FORBIDDEN`                                 | Provider/tool/source/job/session scopes                                                                      | Request the appropriate application permission; never derive authority from run metadata                          |
| `ORIGIN_DENIED`                             | Browser origin and exact host allowlist                                                                      | Register the intended application origin; keep bearer authentication enabled                                      |
| TLS verification fails                      | Hostname, SANs, certificate chain and client trust                                                           | Renew or repair the certificate/CA configuration; keep validation on                                              |
| Provider absent from discovery              | Host configuration and the authenticated grant                                                               | Select a configured, authorized provider instance                                                                 |
| Native CLI appears signed in but cannot run | Exact native version, selected model, account health and effective tool/configuration policy                 | Use the provider-specific readiness evidence; sign-in and adapter compatibility are separate checks               |
| `BUSY` / `QUEUE_FULL`                       | Host subject/account capacity and optional queue                                                             | Wait for capacity or explicitly adjust policy; a retryable rejection does not authorize retrying uncertain work   |
| `IDLE_TIMEOUT`                              | Positive request/host inactivity policy and actual model/tool progress                                       | Inspect the source of the stall; transport heartbeats are not work progress                                       |
| SSE ends without a terminal event           | Proxy timeout, disconnect, host shutdown or network failure                                                  | Treat the outcome as incomplete; inspect its durable operation/job record before retrying                         |
| No RAG evidence                             | Authorized corpus, selected source IDs, current revisions, extraction and embedding configuration            | Reindex the authorized revision or return insufficient evidence; never invent a citation                          |
| Usage unavailable                           | Provider measurement coverage and the selected Usagestat host/account identity                               | Preserve unknown usage and accounting provenance; do not turn a missing measurement into zero                     |

## Check the local host

`agenticdriver doctor --config PATH` validates static CLI configuration and checks
the configured route without generating a model response. `status --refresh`
refreshes authenticated discovery. For an application-authenticated host, use its
normal client and current Better Auth credential for discovery instead of the
static-token CLI helper.

Container `/health` measures host readiness. Check the external HTTPS endpoint
separately for proxy/certificate failures. The stock remote entry redacts startup
errors; verify private mount ownership, the config schema, the application's
introspection endpoint and secret references. See [deployment](deployment.md).

## Native account checks

Use the provider's official sign-in flow as the OS user who owns that dedicated
execution environment. Do not copy consumer tokens into API-key configuration.
Do not disable required tool isolation just to make a connectivity check pass.
The selected Antigravity sign-in is present; its recorded blocker is effective
native tool isolation. Gemini CLI's recorded personal-account rejection is a
separate route. Grok Build's zero idle setting still imposes a ten-second timeout
in the qualified binary. See [provider evidence](providers.md).

## Report a reproducible problem

Include the SDK commit/package version, negotiated protocol version, OS/runtime,
adapter/native version, stable error code, and whether the example is synthetic
or live. For live checks, identify the selected account with an opaque local label
and the explicit model ID. Include sanitized event types and sequence numbers,
not authorization headers, document text or private reasoning.
