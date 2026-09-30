# Changelog

## 0.2.0-rc.3 — candidate

- Added the desktop Overview with real host, provider, account-catalog, application-grant and Usagestat setup status. Partial or unavailable checks remain unknown; metadata does not imply successful model execution.
- Added explicit local and remote installation of the qualified Codex 0.157.0 Linux x64 runtime. The host pins official archive/executable hashes, verifies before installation, supports owned cancellation and preserves native accounts and provider settings.
- Added typed runtime management to TypeScript, Python, Go and Rust and the shared provider panel. Installation, provider sign-in, application grants and model execution remain separate user choices.
- Kept stable Usagestat 2.0.0 compatibility, wire protocol 1.0, existing provider/account/model selections and the disabled default inactivity timeout. Other native installers and platform qualifications remain outside this candidate.

## 0.2.0-rc.2 — 2026-09-30

- Corrected Usagestat quota reads to derive resources from native `/v1/usage` snapshots. Published SDK 0.2.0-rc.1 calls `/v1/limits`, which the backend never served; desktop usage display is unaffected. Account bindings, freshness and failure handling remain explicit. The derived schema is `agenticdriver.usagestat-limits.v1`, replacing the never-served `crossusage.limits.v1` literal.
- Updated integration guidance to released Usagestat **2.0.0**, including optional durable run ingestion, explicit account/subject bindings and the required capability handshake. Native usage reads remain administrative; per-run capture uses a separate credential.
- Kept wire protocol 1.0, selected provider accounts, application authentication and disabled default inactivity timeout unchanged. All three apps now pin the registry RC and passed Prometheus checks plus real metered workflows. The local desktop and regular LitAgent host/metering service were upgraded with retained state. [Publication and limits](docs/validation/release-0.2.0-rc.2.md).

## 0.2.0-rc.1 — 2026-09-29

- Added optional pinned CPU embeddings with real PDF, Markdown and email retrieval, persistent SQLite vectors, bounded worker concurrency/cancellation and tokenizer-reported usage. The model runtime is an opt-in dependency; ordinary SDK installs stay lightweight.
- Added exact source-citation ID validation in TypeScript, Python, Go and Rust, and serializable Rust retrieval results. Missing or invented references are rejected without automatic generation repair.
- Qualified dedicated Linux account containers using actual Codex and Claude subscriptions, with isolated account state, TLS, cancellation, shutdown and restart checks.
- Recorded real native tool approval, executor scope, argument substitution, single-use pairing, revocation and uncertain-effect recovery checks. Historical simulated acceptance is explicitly separated from current evidence.
- Kept temporary CI archives inside job cleanup on Prometheus. Fresh hosts remain empty; account/model selection, billing mode, existing application authentication and disabled default inactivity timeout are preserved.
- Corrected native Claude subscription-limit classification to `RATE_LIMITED`, without automatic retry or exposing native account diagnostics.
- Fixed narrow desktop provider cards and replaced the stale desktop alpha label.

The published RC targets Linux x64, Codex 0.157.0 / gpt-6-luna (medium), Claude Code 2.1.282 / claude-haiku-4-5-20251001, and all four clients. All three apps pin the exact registry RC and have real workflow acceptance receipts. Other catalog entries remain discoverable and unqualified. Wire protocol is 1.0, Python version is 0.2.0rc1, and npm uses the separate rc tag. [The RC gate](docs/release-candidate.md) links exact artifacts, checks and observed content-quality limits. Python uses GitHub archives while PyPI organization approval remains pending.

## 0.2.0-alpha.6

- Removed mock providers, offline setup options, fake embedding adapters and the simulated provider-conformance export.
- Fresh desktop profiles start empty. CLI initialization and application examples require an explicit real provider; legacy mock host configurations report `MOCK_PROVIDER_REMOVED`.
- Removed canned provider/connection/usage preview and acceptance harnesses. Package and pure contract checks remain; model acceptance uses actual selected accounts and prompts.
- Clean build output before compilation so deleted adapters cannot survive in packaged artifacts.

## 0.2.0-alpha.5 — 2026-09-28

- Added desktop-managed outbound OpenSSH routes on Linux: save/edit destinations,
  explicit start/stop, connection-state and recovery messages, and invitation
  routing to the application server's loopback port. Existing SSH identities and
  host trust are reused; keys stay outside the renderer and remote SDK API.
- Preserved paired application grants through same-port tunnel restart. Native
  forwarding acknowledges setup separately from application/provider readiness;
  stopped routes cannot issue managed-tunnel invitations. Active-request guards,
  worker-loss cleanup and explicit reconnection have real OpenSSH coverage.
- Added 76 deterministic brand, literature and email evaluation cases over local
  and authenticated HTTP execution, with a reopened persistent vector store.
  Quality, evidence and action correctness are scored separately from transport.
  Optional live evaluations require explicit paid-call configuration; CI uses no
  model credentials or live inference.
- Bounded disposable build-cache cleanup in the private Prometheus CI daemon.
  npm publication now uses the verified OIDC path introduced after alpha.4,
  avoiding member browser approval for supported workflow publication.
- Fixed completed native CLI invocations hanging when a child retained an output
  pipe. POSIX process groups are reaped on parent exit, buffered output is drained,
  and exit/diagnostic callback failures reject after cleanup. This is process
  cleanup, not isolation from descendants that escape their group.

Wire protocol remains 1.0. Python uses 0.2.0a5. npm, Rust, Go and GitHub downloads
are published; PyPI organization approval remains pending. See [release status](docs/releases.md). Existing application
authentication, provider/model/account selection and execution grants remain
unchanged. No default inference deadline or inactivity timeout is introduced.

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
