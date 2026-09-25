# Changelog

## Unreleased

- Codex provider instances accept an explicit native reasoning effort, including
  host configuration. Required CLI flags now include rule isolation and strict
  configuration validation.
- Recognized Codex authentication, rate-limit and missing-model failures produce
  actionable SDK codes without exposing native diagnostics.
- Repeatable native Codex fixtures cover synthetic accounts, progress, usage,
  cancellation and inherited context. Linux CLI 0.157.0 live text and cancellation
  checks passed with the selected local sign-in and `gpt-6-luna` / medium;
  [remaining limits](docs/validation/codex-2026-09-25.md) stay explicit.

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
