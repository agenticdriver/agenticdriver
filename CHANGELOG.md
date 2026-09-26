# Changelog

## Unreleased

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
