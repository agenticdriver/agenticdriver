# Changelog

## 0.2.0-alpha.4 — 2026-09-27

- Added local, HTTPS and existing SSH-tunnel invitation destinations to the
  desktop, including proxy path prefixes and forward/reverse SSH instructions.
  Destination previews do not consume invitations or contact the destination.
  The desktop keeps operator credentials on the original host and labels
  generated routes as unverified.
- Added authenticated protocol-only connection checks, actionable credential,
  network and TLS errors, saved-host names and same-address reconnection.
  Credential replacement retains the saved host identity and preferences and
  preserves the previous profile if exchange or settings persistence fails.
- Fixed stale provider controls after failed refresh or sign-in status polling.
  The shared component hides account details and management/model actions until
  explicit retry succeeds, then restores the saved selection and preferences.
  A saved host reported offline stays in recovery instead of first-time setup.
  All four language packages include the same recovery behavior; no panel API
  or wire protocol change is required.
- Added actual wide/narrow packaged desktop and native keyboard checks, verified
  private-CA HTTPS/proxy fixtures and an opt-in two-machine SSH check. All CI
  groups now run sequentially on the existing Prometheus runner.

Wire protocol remains 1.0. npm uses `alpha`; stable `latest` stays at 0.1.0.
Python uses 0.2.0a4. See [release status](docs/releases.md) before selecting
download coordinates. No model/account/billing fallback or default inference
deadline/inactivity timeout is introduced.

## 0.2.0-alpha.3 — 2026-09-27

- Added the independent `@agenticdriver/provider-icons` catalogue shared with
  UsageStat-Bar: 155 provider/product marks, monochrome and full colour, and
  related marks such as ChatGPT/Codex and Claude/Claude Code. The provider panel
  stores icon preferences per device, connection and provider. Every language
  package and the desktop companion includes the artwork and its notices.
- Added optional typed connection details across all four clients: native CLI
  version, reported sign-in method/status, subscription, and account email/name.
  The panel masks account identity until Reveal and remasks it on refresh,
  provider changes and disconnect. Missing native fields remain unreported;
  displaying saved sign-in does not qualify execution or change permissions.
- Kept metadata refresh independent of active runs and model execution. Native
  probes retain only bounded display fields, without reading token files in the
  SDK, signing in, refreshing credentials or submitting prompts.
- Extended offline native, protocol and packaged desktop checks for the new
  metadata and privacy controls. Rust integration tests sharing one conformance
  host now run sequentially to avoid competing for its execution capacity.

Wire protocol remains 1.0. npm uses `alpha`; stable `latest` remains 0.1.0.
Python uses 0.2.0a3 and remains a GitHub download while PyPI organization approval
is pending. Existing host grants, model choices and application authentication
remain unchanged.

## 0.2.0-alpha.2 — 2026-09-26

- Empty management hosts show onboarding guidance; read-only connections retain
  provider-grant guidance. Removing the last provider returns to onboarding.

- Fixed `managedHost().management` composition with `serve()` and
  `withConnections()` under TypeScript `exactOptionalPropertyTypes`. Absent
  provider setup is omitted; installed-package checks now enforce strict
  optional-property semantics.
- Exported `readConnectionProfile` from `@agenticdriver/sdk/connections` for
  validated backend metadata without loading bearer credentials or contacting
  a host. Expired metadata remains displayable without implying a usable grant.
- Alpha.1 remains immutable on GitHub, crates.io and Go; its npm upload was
  held after the application checks found the declaration mismatch. Alpha.2
  keeps protocol 1.0 and the existing host/account/model access controls.

## 0.2.0-alpha.1 — 2026-09-26

Opt-in application alpha; wire protocol remains 1.0. npm uses the `alpha`
dist-tag, Rust/Go use `0.2.0-alpha.1`, and Python uses `0.2.0a1`. The Linux
desktop companion shares the alpha version. See [alpha adoption](docs/alpha.md)
for installation, host capabilities and publication status.

- The shared provider component uses constructed stylesheets under strict
  `style-src 'self'`. Added confirmed, revision-checked provider removal across
  all four clients, with explicit support detection and protection for static
  host grants, private credentials and in-flight work.

- Qualified the restricted native Claude 2.1.282 text adapter with offline streaming, cancellation, model refusal and ambient-context checks; added its Prometheus native job. Two inexpensive local Haiku 4.5 checks passed with Usagestat capture. See the [dated account, usage and deployment limits](docs/validation/claude-2026-09-26.md).

- Added caller-bound native Codex device sign-in through the host, all four SDK languages and the shared panel. Desktop preview `0.1.0-alpha.2` exposes the flow. Native verification precedes account confirmation; separate private profiles preserve existing sign-ins and execution grants. See [provider sign-in](docs/provider-sign-in.md).

- Added the Linux desktop companion under `apps/desktop`: provider management, Usagestat snapshots, scoped application invitations and activity, durable local host management, and remote host profiles.

- Empty management hosts support first-run onboarding. Paired clients expose optional process-local last-request and in-flight-request metadata in all four SDK languages.

- Provider management reports a setup catalog shared by TypeScript, Python, Go
  and Rust. The component has a searchable picker, host/account context, guided
  API and compatible-endpoint setup, and official native sign-in instructions.
  Older hosts retain their settings form. Catalog reads do not start login or
  inference; all-model defaults and separate execution grants are preserved.
  Go and Rust configuration round-trips also retain the Codex MCP tool opt-in.
  See [provider connections](docs/provider-connection-design.md).
- Codex now uses the official app-server protocol with environment access disabled,
  explicit native policy controls, inherited MCP servers disabled, and a pinned
  CLI 0.157.0 version check. The earlier exec adapter's zero-tools assertion
  missed Responses Lite tool catalogs and is withdrawn. Native utilities and
  inherited context are documented in the [corrected validation report](docs/validation/codex-2026-09-25.md).
- Native fixtures inspect the effective tool catalog and exercise denied shell,
  file, image, agent, MCP, goal, import and network operations. The sandboxed code
  runtime exposes only the clock tool and no system globals in the tested model.
- Codex provider instances accept explicit reasoning effort, including host
  configuration. Authentication, rate-limit and model errors retain actionable
  codes without exposing native diagnostics. Managed-session tests cover refresh,
  permanent expiry and one bounded policy reload before any prompt is submitted.
- Codex has an opt-in MCP application-tool bridge on qualified Linux x64
  0.157.0. It closes native execution before SDK batch validation, usage checks,
  approvals and local or remote callbacks, then supplies structured history on
  continuation. The default remains text only. No default run deadline or
  inactivity timeout is introduced. See [native tools](docs/native-tools.md).

## 0.1.0 — 2026-09-21

The first SDK release uses wire protocol 1.0. npm, crates.io and the public Go
module are published; Python archives are available from the GitHub release
while PyPI organization approval is pending. Package publication does not imply
provider-account certification. See the [release inventory](docs/releases.md).

- TypeScript/JavaScript runtime and clients, typed Python sync/async clients,
  Go client and Rust blocking/async clients share a versioned protocol.
- Explicit provider/account/model selection, streaming, cancellation, optional
  inactivity, sessions, durable jobs, idempotency and tenant capacity controls.
- Application tools, approvals, selected context, artifacts, RAG/vector store
  interfaces, and revision-aware PDF, Markdown and email ingestion.
- Better Auth device/service grants paired with the existing AuthYard connector;
  scoped introspection and current authority for durable work.
- Existing Usagestat backend integration for account-scoped usage and provider
  metadata; optional redacted diagnostics and OpenTelemetry integration.
- Host CLI, Linux containers with verified HTTPS, provider extensions, four
  language quickstarts and three synthetic application recipes.

No SDK run deadline or inactivity timeout is enabled by default. The native
limitations in [provider setup](docs/providers.md), pending live application
checks and the unpublished PyPI channel remain explicit.
