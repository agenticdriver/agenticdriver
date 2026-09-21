# Changelog

## 0.1.0 candidate — unreleased

This first working SDK candidate uses wire protocol 1.0. It is not a registry
release or provider-account certification. See the [release inventory](docs/releases.md).

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
checks, private source access and unpublished registries remain explicit.
