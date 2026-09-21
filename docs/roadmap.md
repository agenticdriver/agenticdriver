# AgenticDriver SDK implementation roadmap

The live [organization project](https://github.com/orgs/agenticdriver/projects/1) contains all 48 work items. The canonical initial item data is in [roadmap.json](roadmap.json). Ongoing status and discussion live in GitHub Projects.

## Decisions

- Call the product an SDK. Keep runtime, protocol, host, providers and language clients in one SDK repository initially; applications remain in their own repositories.
- The SDK repository remains under the personal account until a transfer is explicitly chosen. This organization project can track work across owners and repositories.
- Support all three application workstreams: Brandstorm, agentic-literature-review and AI Workspace.
- No default total run deadline and no default inactivity timeout. Applications can opt into idleTimeoutMs; actual model or tool progress resets it, transport heartbeats do not.
- Use official provider authentication and supported integration routes. CLI sessions may use subscription or API billing; never assume every subscription is an API entitlement.
- Applications own domain data, accepted artifacts and business workflows. The SDK supplies execution primitives and optional host services.
- Keep provider credentials on the execution host. Requests select configured instances and explicitly permitted tools.
- Use project drafts initially. Convert each draft into an issue in its Target repository when work is picked up, retaining its roadmap ID and dependencies.

## Existing local foundation

- A local v0.1 implementation exists: TypeScript runtime, HTTP/SSE host, API adapters, restricted text-only CLI adapters, and TypeScript, Python, Go and Rust clients.
- Tool input and output validation, cancellation, optional inactivity handling, scoped bearer authentication, usage callbacks and Usagestat read integration are implemented.
- All three repositories have initial integrations and synthetic examples. Brandstorm and LitAgent use remote clients; AI Workspace has a mailbox-backed triage interface.
- Local tests, type checks, builds and four-client HTTP/HTTPS checks passed during implementation. Provider execution is fixture-tested; live provider accounts and all supported operating systems have not been certified.
- The SDK has not been published. Consumer integrations use source checkouts or pinned local package archives. CLI adapters do not yet support application tools. The host now offers opt-in durable jobs; device pairing and a relay remain pending.

## Phases

These are scope milestones, not calendar deadlines. P0 means a prerequisite or release blocker, P1 means planned implementation, and P2 means an optional extension. All items below start in Todo; existing work is described above and in each item.

- **Alpha:** Installable SDK, live provider validation, usable language clients and a connected workflow in each application.
- **Beta:** Account lifecycle, richer tools and context, optional durable execution, and complete application workflows.
- **v1:** Compatibility, security, operational and documentation release gates met for the supported matrix.
- **Later:** Optional capabilities that must not hold up the core SDK. No release dates are implied.

## Components to implement

| ID                | Work                                                                     | Component            | Phase | Priority | Target                    |
| ----------------- | ------------------------------------------------------------------------ | -------------------- | ----- | -------- | ------------------------- |
| [AD-001](#ad-001) | Define protocol versioning, capabilities and error compatibility         | Protocol             | Alpha | P0       | agenticdriver             |
| [AD-002](#ad-002) | Build shared protocol conformance fixtures for every client              | Protocol             | Alpha | P0       | agenticdriver             |
| [AD-003](#ad-003) | Add refreshable provider, model and account health discovery             | Providers            | Alpha | P0       | agenticdriver             |
| [AD-004](#ad-004) | Support explicit conversation continuation and session state             | Runtime              | Beta  | P1       | agenticdriver             |
| [AD-005](#ad-005) | Add optional durable jobs, status lookup and event replay                | Runtime              | Beta  | P1       | agenticdriver             |
| [AD-006](#ad-006) | Define idempotency and opt-in retry behavior                             | Runtime              | Beta  | P0       | agenticdriver             |
| [AD-007](#ad-007) | Expose interactive tool approval requests and decisions                  | Tools and context    | Beta  | P0       | agenticdriver             |
| [AD-008](#ad-008) | Let Python, Go, Rust and remote applications supply tools                | Tools and context    | Beta  | P1       | agenticdriver             |
| [AD-009](#ad-009) | Bridge approved application tools into supported native agents via MCP   | Tools and context    | Beta  | P1       | agenticdriver             |
| [AD-010](#ad-010) | Define attachments, context references and artifact delivery             | Tools and context    | Beta  | P1       | agenticdriver             |
| [AD-011](#ad-011) | Ship an installable local host CLI with configuration and diagnostics    | Local host           | Alpha | P0       | agenticdriver             |
| [AD-012](#ad-012) | Harden native process isolation across supported operating systems       | Local host           | Beta  | P0       | agenticdriver             |
| [AD-013](#ad-013) | Add device pairing and revocable scoped credentials                      | Remote access        | Beta  | P0       | agenticdriver             |
| [AD-014](#ad-014) | Package a secure self-hosted remote deployment                           | Remote access        | Alpha | P1       | agenticdriver             |
| [AD-015](#ad-015) | Evaluate and implement an optional outbound relay for private devices    | Remote access        | Later | P2       | agenticdriver             |
| [AD-016](#ad-016) | Add tenant-aware scheduling and optional resource budgets                | Runtime              | Beta  | P1       | agenticdriver             |
| [AD-017](#ad-017) | Validate the OpenAI API adapter against live supported models            | Providers            | Alpha | P0       | agenticdriver             |
| [AD-018](#ad-018) | Validate the Anthropic API adapter against live supported models         | Providers            | Alpha | P0       | agenticdriver             |
| [AD-019](#ad-019) | Validate the Gemini API adapter against live supported models            | Providers            | Alpha | P0       | agenticdriver             |
| [AD-020](#ad-020) | Validate xAI API support and add a native Responses adapter              | Providers            | Alpha | P1       | agenticdriver             |
| [AD-021](#ad-021) | Certify the official Codex CLI session adapter                           | Providers            | Alpha | P0       | agenticdriver             |
| [AD-022](#ad-022) | Certify the official Claude Code integration and authentication path     | Providers            | Alpha | P0       | agenticdriver             |
| [AD-023](#ad-023) | Certify the official Gemini CLI session adapter                          | Providers            | Alpha | P0       | agenticdriver             |
| [AD-024](#ad-024) | Publish a provider extension contract and custom/local endpoint example  | Providers            | Beta  | P1       | agenticdriver             |
| [AD-025](#ad-025) | Finish TypeScript and JavaScript installation and client ergonomics      | Language clients     | Alpha | P1       | agenticdriver             |
| [AD-026](#ad-026) | Add typed synchronous and asynchronous Python clients                    | Language clients     | Alpha | P1       | agenticdriver             |
| [AD-027](#ad-027) | Stabilize the Go client module and streaming lifecycle                   | Language clients     | Alpha | P1       | agenticdriver             |
| [AD-028](#ad-028) | Add an async Rust client and finish crate ergonomics                     | Language clients     | Alpha | P1       | agenticdriver             |
| [AD-029](#ad-029) | Define account-scoped usage identity and accounting semantics            | Usage and metadata   | Alpha | P0       | agenticdriver             |
| [AD-030](#ad-030) | Add a durable Usagestat run-metering ingestion contract                  | Usage and metadata   | Beta  | P1       | usagestat                 |
| [AD-031](#ad-031) | Reuse Usagestat provider icons, metadata and quota freshness             | Usage and metadata   | Alpha | P1       | agenticdriver             |
| [AD-032](#ad-032) | Expose structured diagnostics, metrics and optional tracing              | Observability        | Beta  | P1       | agenticdriver             |
| [AD-033](#ad-033) | Add Brandstorm connection setup, account selection and live validation   | Applications         | Alpha | P0       | brandstorm                |
| [AD-034](#ad-034) | Extend Brandstorm brainstorming with scoped context, tools and proposals | Applications         | Beta  | P1       | brandstorm                |
| [AD-035](#ad-035) | Finish LitAgent connection settings and refreshable driver discovery     | Applications         | Alpha | P0       | agentic-literature-review |
| [AD-036](#ad-036) | Power resumable literature review stages with evidence-linked tools      | Applications         | Beta  | P1       | agentic-literature-review |
| [AD-037](#ad-037) | Connect AI Workspace triage to a real authenticated mailbox              | Applications         | Alpha | P0       | ai-workspace              |
| [AD-038](#ad-038) | Build AI Workspace review and approved action workflows                  | Applications         | Beta  | P1       | ai-workspace              |
| [AD-039](#ad-039) | Create end-to-end evaluations for all three application scenarios        | Quality and security | Alpha | P1       | agenticdriver             |
| [AD-040](#ad-040) | Expand CI across operating systems, versions and network failure modes   | Quality and security | Alpha | P1       | agenticdriver             |
| [AD-041](#ad-041) | Review and test execution, pairing and tenant trust boundaries           | Quality and security | v1    | P0       | agenticdriver             |
| [AD-042](#ad-042) | Publish versioned SDK packages and remove sibling-checkout dependencies  | Releases and docs    | Alpha | P0       | agenticdriver             |
| [AD-043](#ad-043) | Write SDK onboarding, provider setup and three application recipes       | Releases and docs    | Alpha | P1       | agenticdriver             |
| [AD-044](#ad-044) | Complete v1 operational and compatibility release gates                  | Quality and security | v1    | P0       | agenticdriver             |
| [AD-045](#ad-045) | Investigate an official Grok subscription integration route              | Providers            | Later | P2       | agenticdriver             |

## Work item details

<a id="ad-001"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042278)

### AD-001 — Define protocol versioning, capabilities and error compatibility

**Target:** agenticdriver · **Component:** Protocol · **Phase:** Alpha · **Priority:** P0

**Current state:** OpenAPI and ordered run events exist, but there is no documented schema evolution or client/host version negotiation policy.

**Scope:** Specify supported versions, capability discovery, stable error codes, event extension rules and compatibility guarantees across every language client.

**Completion criteria:**

- [ ] Version and capability negotiation reject incompatible requests before execution.
- [ ] Additive fields and unknown optional events have a documented compatibility policy with old/new client fixtures.
- [ ] Document cancellation, terminal events and the existing disabled-by-default inactivity semantics as protocol guarantees.

**Depends on:** None.

<a id="ad-002"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042301)

### AD-002 — Build shared protocol conformance fixtures for every client

**Target:** agenticdriver · **Component:** Protocol · **Phase:** Alpha · **Priority:** P0

**Current state:** The four clients have a working HTTP/HTTPS smoke harness and separate tests.

**Scope:** Create language-neutral fixtures and a reference host that exercise identical protocol behavior across TypeScript, Python, Go and Rust.

**Completion criteria:**

- [ ] Every client passes fragmented Unicode/SSE, large frames, typed errors, terminal ordering, malformed streams and cancellation cases.
- [ ] Certificate verification, forbidden redirects, auth scoping and connection cleanup are checked consistently.
- [ ] A controlled clock or deterministic progress source verifies optional idle expiration and absence of a default run timer.

**Depends on:** [AD-001](#ad-001)

<a id="ad-003"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042316)

### AD-003 — Add refreshable provider, model and account health discovery

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** Hosts expose configured provider instances, explicit model allowlists and capability flags; account setup and catalog refresh are manual.

**Scope:** Expose safe connection health and refreshable model inventory, while distinguishing unavailable, unauthenticated and unsupported capabilities.

**Completion criteria:**

- [ ] Multiple instances of one vendor remain distinguishable and visible only to authorized subjects.
- [ ] Expired credentials and missing CLI binaries produce actionable, redacted status without triggering billable model runs.
- [ ] Model selection stays explicit; authentication or quota errors never silently switch provider, account or billing mode.

**Depends on:** [AD-001](#ad-001)

<a id="ad-004"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042345)

### AD-004 — Support explicit conversation continuation and session state

**Target:** agenticdriver · **Component:** Runtime · **Phase:** Beta · **Priority:** P1

**Current state:** History can be supplied to a run and native provider state is preserved within its tool loop; there is no cross-run session contract.

**Scope:** Design opt-in session handles and portable application history with explicit provider-specific continuation capabilities.

**Completion criteria:**

- [ ] Applications can continue an authorized conversation and delete its stored state.
- [ ] Provider-specific opaque state is scoped to its account and never exposed as private reasoning text.
- [ ] Unsupported provider switching is explicit, with bounded context and documented retention; no hidden long-term memory is introduced.

**Depends on:** [AD-001](#ad-001), [AD-010](#ad-010)

<a id="ad-005"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042364)

### AD-005 — Add optional durable jobs, status lookup and event replay

**Target:** agenticdriver · **Component:** Runtime · **Phase:** Beta · **Priority:** P1

**Current state:** The host is stateless between runs, and disconnecting an active request cancels its execution.

**Scope:** Offer a pluggable host-side job store and queue for applications that need background reviews or inbox processing. Keep the lightweight in-process path available.

**Completion criteria:**

- [ ] Explicit detached jobs support submit, inspect, cancel and reconnect/replay using an ordered cursor with tenant isolation.
- [ ] Restart recovery distinguishes queued, interrupted and completed jobs without repeating completed tool effects.
- [ ] Applications retain workflow checkpoints and domain state; persistence and retention are configured rather than silently enabled.
- [ ] No job duration deadline is introduced; idle policies and worker leases have separate documented meanings.

**Depends on:** [AD-001](#ad-001), [AD-006](#ad-006), [AD-016](#ad-016)

<a id="ad-006"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042389)

### AD-006 — Define idempotency and opt-in retry behavior

**Target:** agenticdriver · **Component:** Runtime · **Phase:** Beta · **Priority:** P0

**Current state:** The SDK intentionally performs no automatic retries, including after application tool effects.

**Scope:** Add request deduplication and bounded, opt-in retries for demonstrably safe failures; document indeterminate provider and tool outcomes.

**Completion criteria:**

- [ ] Replaying an idempotency key does not execute an accepted operation twice; conflicting request payloads are rejected.
- [ ] Retryable provider failures respect server hints and cancellation without changing the chosen model or credentials.
- [ ] A tool effect followed by connection loss yields a recoverable recorded outcome or explicit uncertainty, never blind replay.

**Depends on:** [AD-001](#ad-001)

<a id="ad-007"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042412)

### AD-007 — Expose interactive tool approval requests and decisions

**Target:** agenticdriver · **Component:** Tools and context · **Phase:** Beta · **Priority:** P0

**Current state:** A host approval callback can allow a tool, but clients have no authenticated approval request/response lifecycle.

**Scope:** Add structured approval events and explicit decisions so applications can show proposed actions before execution.

**Completion criteria:**

- [ ] Decisions bind to the authenticated subject, run, tool name and exact arguments; stale or altered decisions are rejected.
- [ ] Deny, cancel and application-selected expiry paths are defined and audited without side effects.
- [ ] Waiting for a person has explicit lifecycle and idle-policy semantics; approval UI stays in the consuming application.

**Depends on:** [AD-001](#ad-001), [AD-006](#ad-006)

<a id="ad-008"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042431)

### AD-008 — Let Python, Go, Rust and remote applications supply tools

**Target:** agenticdriver · **Component:** Tools and context · **Phase:** Beta · **Priority:** P1

**Current state:** Application tools are registered in the TypeScript execution host. Other clients can select these tools but cannot host their own callbacks.

**Scope:** Define an authenticated tool executor transport and language bindings for application-owned functions, with JSON Schema inputs and results.

**Completion criteria:**

- [ ] One application-defined tool runs from each supported language against a local and remote driver.
- [ ] Invocation IDs, allowlists, schema validation, progress, cancellation, output bounds and approval decisions survive the round trip.
- [ ] Disconnected executors fail clearly; requests cannot introduce arbitrary shell commands or replace authenticated identity.

**Depends on:** [AD-001](#ad-001), [AD-006](#ad-006), [AD-007](#ad-007)

<a id="ad-009"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042451)

### AD-009 — Bridge approved application tools into supported native agents via MCP

**Target:** agenticdriver · **Component:** Tools and context · **Phase:** Beta · **Priority:** P1

**Current state:** Native CLI integrations are deliberately text-only with native tools and MCP disabled.

**Scope:** Add an opt-in MCP bridge exposing only registered application tools to native runtimes where official integration mechanisms permit it.

**Completion criteria:**

- [ ] Capability flags distinguish verified tool-enabled integrations from text-only or unsupported providers.
- [ ] A native agent completes a tool round trip with schema validation, approval, cancellation and usage attribution.
- [ ] Ambient MCP servers, hooks, extensions and local filesystem tools remain outside the application allowlist; least-privilege behavior is tested.

**Depends on:** [AD-007](#ad-007), [AD-008](#ad-008), [AD-021](#ad-021), [AD-022](#ad-022), [AD-023](#ad-023)

<a id="ad-010"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042468)

### AD-010 — Define attachments, context references and artifact delivery

**Target:** agenticdriver · **Component:** Tools and context · **Phase:** Beta · **Priority:** P1

**Current state:** The portable contract supports text and validated JSON. Apps manually supply selected evidence and store returned text artifacts.

**Scope:** Add bounded document/image inputs, application-owned content references and output artifacts with explicit provider capabilities.

**Completion criteria:**

- [ ] Local and remote workflows can send a selected document or image without exposing arbitrary host paths.
- [ ] Reference authorization, media types, size limits, retention and cancellation cleanup are specified and tested.
- [ ] Applications retain citation/provenance metadata and approve canonical artifact changes; unsupported modalities fail before execution.

**Depends on:** [AD-001](#ad-001), [AD-003](#ad-003)

<a id="ad-011"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042484)

### AD-011 — Ship an installable local host CLI with configuration and diagnostics

**Target:** agenticdriver · **Component:** Local host · **Phase:** Alpha · **Priority:** P0

**Current state:** The host is started by an example TypeScript script and environment variables.

**Scope:** Provide init, serve, status and doctor commands with validated configuration, provider setup guidance and graceful shutdown.

**Completion criteria:**

- [ ] A fresh installation can run a mock workflow and connect an explicitly selected provider without editing SDK source.
- [ ] Configuration separates non-secret settings from OS keychain or supplied secret-store references; diagnostics redact credentials.
- [ ] Loopback is the default; non-loopback exposure requires the existing secure transport and authentication conditions.
- [ ] Service installation and upgrades document the running user, config paths and shutdown/cancellation behavior.

**Depends on:** [AD-003](#ad-003)

<a id="ad-012"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042492)

### AD-012 — Harden native process isolation across supported operating systems

**Target:** agenticdriver · **Component:** Local host · **Phase:** Beta · **Priority:** P0

**Current state:** CLI adapters restrict flags, environment, working directory and output; mutually untrusted accounts still require separate OS users or containers.

**Scope:** Implement and document per-account execution isolation, subprocess cleanup and platform-specific process tree termination.

**Completion criteria:**

- [ ] Linux, macOS and Windows tests demonstrate cancellation leaves no surviving agent child processes or temporary prompt files.
- [ ] Concurrent accounts cannot read another account's credentials, workspace, output or inherited environment.
- [ ] Unsupported isolation guarantees are explicit; restricted CLI flags alone are never described as an OS sandbox.

**Depends on:** [AD-011](#ad-011), [AD-021](#ad-021), [AD-022](#ad-022), [AD-023](#ad-023)

<a id="ad-013"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042502)

### AD-013 — Add device pairing and revocable scoped credentials

**Target:** agenticdriver · **Component:** Remote access · **Phase:** Beta · **Priority:** P0

**Current state:** Hosts use a startup token registry. There is no user-facing pairing, token expiry or rotation without restart.

**Scope:** Add explicit app-to-host pairing, short-lived access credentials and independently revocable grants for devices, providers and tools.

**Completion criteria:**

- [ ] Pairing requires a deliberate device/user confirmation and cannot be completed by an unrelated web origin.
- [ ] Grant rotation, expiry and revocation take effect without leaking provider credentials or confusing account identity.
- [ ] OS secret storage and backend service credentials are supported; browser credentials have narrow scopes and documented storage constraints.

**Depends on:** [AD-001](#ad-001), [AD-011](#ad-011)

<a id="ad-014"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042512)

### AD-014 — Package a secure self-hosted remote deployment

**Target:** agenticdriver · **Component:** Remote access · **Phase:** Alpha · **Priority:** P1

**Current state:** The HTTPS host, scoped bearer tokens and exact-origin CORS work; remote installation is manual.

**Scope:** Provide a container/service deployment recipe with TLS or a loopback TLS proxy, health checks, secrets injection and operational guidance.

**Completion criteria:**

- [ ] A fresh remote deployment runs a selected workflow from each language client using verified TLS.
- [ ] Reverse proxy streaming, disconnect cancellation, headers, graceful shutdown and capacity errors are exercised.
- [ ] Deployment templates do not impose a default total run deadline; unavoidable provider or infrastructure limits are documented.

**Depends on:** [AD-011](#ad-011)

<a id="ad-015"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042523)

### AD-015 — Evaluate and implement an optional outbound relay for private devices

**Target:** agenticdriver · **Component:** Remote access · **Phase:** Later · **Priority:** P2

**Current state:** A hosted application cannot automatically reach a user's laptop; it needs a reachable HTTPS host or trusted tunnel.

**Scope:** Compare a documented tunnel integration with an outbound relay, then implement the smallest supported option that solves device reachability.

**Completion criteria:**

- [ ] A browser/server reaches a paired local driver behind NAT without exposing an unauthenticated listening port.
- [ ] The relay's trust boundary, encryption endpoints, metadata visibility, revocation and reconnect behavior are documented and tested.
- [ ] Provider credentials stay on the execution machine; direct local and remote modes work without the relay.

**Depends on:** [AD-013](#ad-013), [AD-014](#ad-014), [AD-041](#ad-041)

<a id="ad-016"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042535)

### AD-016 — Add tenant-aware scheduling and optional resource budgets

**Target:** agenticdriver · **Component:** Runtime · **Phase:** Beta · **Priority:** P1

**Current state:** The host bounds concurrency globally and per subject, plus step and output sizes; it has no fair queue or account-aware admission policy.

**Scope:** Add explicit concurrency, queue and optional token/cost policies that applications or operators can configure per account and subject.

**Completion criteria:**

- [ ] One tenant cannot starve all others; queue saturation and rejected admissions return typed, actionable errors.
- [ ] Unknown usage or cost remains unknown, with a defined policy instead of being counted as zero.
- [ ] Admission and spend controls never introduce an implicit elapsed-time cutoff or silently select a different provider.

**Depends on:** [AD-001](#ad-001), [AD-029](#ad-029)

<a id="ad-017"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042543)

### AD-017 — Validate the OpenAI API adapter against live supported models

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The Responses adapter streams text and preserves native tool-loop state; protocol behavior has been tested with fixtures.

**Scope:** Run an opt-in live conformance suite using a host-owned API credential and explicit model IDs.

**Completion criteria:**

- [ ] Record successful streaming, tool calls, structured output, usage, cancellation and a three-app smoke path.
- [ ] Exercise supported refusal, truncation, throttling and invalid-auth behavior with sanitized fixtures.
- [ ] Publish the verified model/API matrix and verification date; account credentials and paid tests remain opt-in.

**Depends on:** [AD-002](#ad-002)

<a id="ad-018"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042555)

### AD-018 — Validate the Anthropic API adapter against live supported models

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The Messages adapter streams text/tool input and retains signed thinking blocks inside the native loop; verification uses fixtures.

**Scope:** Certify the official API path with explicit models, including reasoning-capable tool turns where supported.

**Completion criteria:**

- [ ] Streaming, tools, output validation, cache/token accounting and cancellation pass a live suite.
- [ ] Native signed state survives multiple tool turns without exposing private reasoning content to apps.
- [ ] Document observed authentication, capacity, refusal and truncation behavior with a dated support matrix.

**Depends on:** [AD-002](#ad-002)

<a id="ad-019"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042564)

### AD-019 — Validate the Gemini API adapter against live supported models

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The streaming generateContent adapter preserves function-call thought signatures and normalizes usage from fixtures.

**Scope:** Certify text, reasoning-capable function calling and validated outputs against explicitly configured official models.

**Completion criteria:**

- [ ] Multi-turn tools retain required native signatures, with text progress and cancellation visible to clients.
- [ ] Safety blocks, limits, output truncation, cache counts and thought-token accounting have verified handling.
- [ ] Publish supported endpoints/models and capability limits without inferring subscription entitlements.

**Depends on:** [AD-002](#ad-002)

<a id="ad-020"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042575)

### AD-020 — Validate xAI API support and add a native Responses adapter

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P1

**Current state:** xAI uses the existing compatible Chat Completions adapter. Native xAI Responses is not implemented.

**Scope:** Verify the currently supported xAI integration contracts and implement a native adapter where it improves supported capabilities.

**Completion criteria:**

- [ ] Live text, tools, streaming, usage and cancellation work with explicit xAI API credentials and models.
- [ ] Native state and error handling have conformance fixtures; migration preserves the configured account and model.
- [ ] Documentation distinguishes API support from the separate, unverified Grok subscription path.

**Depends on:** [AD-002](#ad-002)

<a id="ad-021"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042583)

### AD-021 — Certify the official Codex CLI session adapter

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The adapter uses official CLI flags, stdin and restricted execution, with fake-process tests and item-level progress rather than guaranteed token streaming.

**Scope:** Validate supported installed CLI versions with the user's own normal sign-in and document subscription/API billing distinctions.

**Completion criteria:**

- [ ] Live text runs, progress, usage when reported, cancellation and expired-session errors work without credential extraction.
- [ ] Temporary workspace isolation, disabled ambient hooks/tools and account selection are verified against the real binary.
- [ ] Document the version range and actual streaming capabilities; unsupported versions fail preflight with useful guidance.

**Depends on:** [AD-002](#ad-002), [AD-003](#ad-003)

<a id="ad-022"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042591)

### AD-022 — Certify the official Claude Code integration and authentication path

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The restricted CLI text adapter uses stream-json, but live account execution and supported distribution scenarios still need verification.

**Scope:** Check current official integration requirements and test the supported end-user CLI route; use the API route for unsupported hosted consumer-auth scenarios.

**Completion criteria:**

- [ ] A supported live CLI session streams and cancels correctly without exposing credentials or enabling ambient tools.
- [ ] Document supported versions, sign-in ownership and deployment constraints using current official guidance.
- [ ] CLI cost estimates are labeled separately from actual subscription charges; unsupported auth routes are not advertised as available.

**Depends on:** [AD-002](#ad-002), [AD-003](#ad-003)

<a id="ad-023"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042603)

### AD-023 — Certify the official Gemini CLI session adapter

**Target:** agenticdriver · **Component:** Providers · **Phase:** Alpha · **Priority:** P0

**Current state:** The headless stream-json adapter applies explicit restrictions and preserves the CLI's account directory; behavior is fixture-tested.

**Scope:** Verify supported live CLI versions and their normal cached-auth routes, quotas, progress and tool-disable controls.

**Completion criteria:**

- [ ] Live text runs, progress, cancellation, quota failures and expired-session errors are normalized.
- [ ] No ambient extensions, hooks, context files or tools become available through an application request.
- [ ] Document actual auth modes, usage fields and supported versions; do not infer the user's subscription tier.

**Depends on:** [AD-002](#ad-002), [AD-003](#ad-003)

<a id="ad-024"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042614)

### AD-024 — Publish a provider extension contract and custom/local endpoint example

**Target:** agenticdriver · **Component:** Providers · **Phase:** Beta · **Priority:** P1

**Current state:** ProviderAdapter and an OpenAI-compatible factory exist, but third-party implementers have no packaged compatibility kit.

**Scope:** Document and stabilize adapter construction, credentials, capabilities, progress, cancellation and native state; demonstrate a configured local or enterprise endpoint.

**Completion criteria:**

- [ ] An independent adapter passes the shared conformance suite without modifying the runtime or clients.
- [ ] Local endpoints use explicit host-owned URLs and models; remote callers cannot redirect requests to arbitrary hosts.
- [ ] Extensions declare versions and capabilities, and are loaded only by trusted host configuration.

**Depends on:** [AD-001](#ad-001), [AD-002](#ad-002), [AD-003](#ad-003)

<a id="ad-025"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042625)

### AD-025 — Finish TypeScript and JavaScript installation and client ergonomics

**Target:** agenticdriver · **Component:** Language clients · **Phase:** Alpha · **Priority:** P1

**Current state:** The SDK has typed local execution and a browser-safe fetch client; consumers currently install from a sibling checkout.

**Scope:** Polish the public TypeScript/JavaScript API, entry points, errors and examples for browser and server applications.

**Completion criteria:**

- [ ] An installed package works in a plain JavaScript app, TypeScript server and browser bundle without importing server secrets or Node-only code.
- [ ] run, stream, provider discovery and AbortSignal behavior have concise examples and stable types.
- [ ] Bundle/export checks and compiled declarations run from the packed artifact, independent of the monorepo source tree.

**Depends on:** [AD-001](#ad-001), [AD-002](#ad-002)

<a id="ad-026"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042635)

### AD-026 — Add typed synchronous and asynchronous Python clients

**Target:** agenticdriver · **Component:** Language clients · **Phase:** Alpha · **Priority:** P1

**Current state:** A standard-library synchronous client provides run and stream operations with verified TLS and no default run timeout.

**Scope:** Add typed request/event/result models, an async interface and idiomatic lifecycle management while preserving a simple installation.

**Completion criteria:**

- [ ] Sync and async usage pass shared fixtures, with stream context management and cancellation releasing connections.
- [ ] A fresh Python application installs a built wheel and runs local-host and remote HTTPS workflows.
- [ ] Type checking, custom CA support and explicit timeout behavior are documented; no implicit run deadline is introduced.

**Depends on:** [AD-001](#ad-001), [AD-002](#ad-002)

<a id="ad-027"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042646)

### AD-027 — Stabilize the Go client module and streaming lifecycle

**Target:** agenticdriver · **Component:** Language clients · **Phase:** Alpha · **Priority:** P1

**Current state:** The Go client supports JSON runs and streamed callbacks using caller-owned contexts.

**Scope:** Finish typed events/results, error inspection, HTTP transport injection and a consumable module path.

**Completion criteria:**

- [ ] A separate Go module installs the client and runs against local and remote hosts without repository-relative replacements.
- [ ] Context cancellation, callback termination and transport errors release goroutines and response bodies.
- [ ] Shared conformance tests and race checks pass; caller context deadlines remain explicit application choices.

**Depends on:** [AD-001](#ad-001), [AD-002](#ad-002)

<a id="ad-028"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042651)

### AD-028 — Add an async Rust client and finish crate ergonomics

**Target:** agenticdriver · **Component:** Language clients · **Phase:** Alpha · **Priority:** P1

**Current state:** The Rust crate uses blocking reqwest, typed requests and callback streaming with its default total request timeout disabled.

**Scope:** Provide async streaming and cancellation alongside an optional blocking interface, stable event/error types and documented feature flags.

**Completion criteria:**

- [ ] A separate Rust application installs a packaged crate and runs both client styles against local and HTTPS hosts.
- [ ] Dropping or cancelling a stream stops upstream work and cleans up resources; TLS verification stays enabled.
- [ ] Conformance, minimal-feature and minimum-supported-Rust checks pass without adding a hidden run deadline.

**Depends on:** [AD-001](#ad-001), [AD-002](#ad-002)

<a id="ad-029"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042658)

### AD-029 — Define account-scoped usage identity and accounting semantics

**Target:** agenticdriver · **Component:** Usage and metadata · **Phase:** Alpha · **Priority:** P0

**Current state:** Usage callbacks include trusted subject, run, provider instance and model; Usagestat mappings are provider-level and account joins are application-owned.

**Scope:** Specify stable execution/account identifiers, usage provenance, incomplete totals and the relationship between run metering and account quota snapshots.

**Completion criteria:**

- [ ] Two accounts of the same vendor cannot receive each other's usage or quota attribution.
- [ ] Unknown token/cost data remains absent; cache subsets, reasoning counts and API-equivalent estimates have explicit meanings.
- [ ] Identity, schema versioning and retention support a durable sink without logging prompts, private reasoning or credentials.

**Depends on:** [AD-001](#ad-001), [AD-003](#ad-003)

<a id="ad-030"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042672)

### AD-030 — Add a durable Usagestat run-metering ingestion contract

**Target:** usagestat · **Component:** Usage and metadata · **Phase:** Beta · **Priority:** P1

**Current state:** Usagestat has public read APIs but no run-event ingestion endpoint; AgenticDriver offers callbacks and a single-process JSONL sink.

**Scope:** Design and implement an authenticated ingestion boundary in Usagestat and a matching optional AgenticDriver sink, without duplicating existing provider probes.

**Completion criteria:**

- [ ] Retries deduplicate completed run records using a scoped stable key and preserve partial or unknown measurements.
- [ ] Buffered delivery, backpressure, offline recovery and reconciliation are tested; telemetry failure does not replay model or tool work.
- [ ] Per-account access and retention are enforced, with explicit schema compatibility between both repositories.

**Depends on:** [AD-006](#ad-006), [AD-029](#ad-029)

<a id="ad-031"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042679)

### AD-031 — Reuse Usagestat provider icons, metadata and quota freshness

**Target:** agenticdriver · **Component:** Usage and metadata · **Phase:** Alpha · **Priority:** P1

**Current state:** The read client preserves provider metadata, icon references, usage snapshots and the actual limits schema; remote icon paths are not browser assets.

**Scope:** Add documented app-facing catalog helpers and a trusted asset delivery/cache recipe shared by the three integrations.

**Completion criteria:**

- [ ] Apps show the correct provider/account identity, accessible names and licensed icon variants without copying Usagestat probe logic.
- [ ] Missing icons and stale/error quota snapshots have explicit fallback displays; quotas are not treated as exact per-run usage.
- [ ] Remote asset delivery uses catalog allowlists, never an arbitrary filesystem read endpoint or credential-bearing URL.

**Depends on:** [AD-029](#ad-029)

<a id="ad-032"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042689)

### AD-032 — Expose structured diagnostics, metrics and optional tracing

**Target:** agenticdriver · **Component:** Observability · **Phase:** Beta · **Priority:** P1

**Current state:** Run events and prompt-free usage callbacks expose lifecycle data; there is no standard tracing or operational metrics integration.

**Scope:** Add optional OpenTelemetry-compatible spans/metrics and structured diagnostic hooks for host, provider and tool execution.

**Completion criteria:**

- [ ] Applications correlate their request ID with run/provider/tool spans, queue time, progress and final outcomes.
- [ ] Content and secret redaction is the default; private reasoning is not exported, and diagnostic verbosity is explicitly configured.
- [ ] Broken exporters do not stall execution or cause retries; instrumentation overhead and cardinality are bounded.

**Depends on:** [AD-001](#ad-001), [AD-029](#ad-029)

<a id="ad-033"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042695)

### AD-033 — Add Brandstorm connection setup, account selection and live validation

**Target:** brandstorm · **Component:** Applications · **Phase:** Alpha · **Priority:** P0

**Current state:** The Bridge adapter is implemented and tested, with keychain-backed token configuration and namespaced model discovery; there is no dedicated setup UI.

**Scope:** Create a complete settings flow to add a local or remote AgenticDriver connection, select its permitted provider/model and diagnose connection failures.

**Completion criteria:**

- [ ] A user configures the connection through the existing UI, selects an explicit model and completes a live structured brainstorm.
- [ ] Connection/auth errors, cancellation and incomplete output map to Brandstorm's existing lifecycle without silent fallback.
- [ ] The adapter consumes an installable SDK artifact; credentials remain in the existing secure configuration store.

**Depends on:** [AD-003](#ad-003), [AD-011](#ad-011), [AD-025](#ad-025), [AD-031](#ad-031)

<a id="ad-034"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042705)

### AD-034 — Extend Brandstorm brainstorming with scoped context, tools and proposals

**Target:** brandstorm · **Component:** Applications · **Phase:** Beta · **Priority:** P1

**Current state:** The adapter supports text and JSON artifacts; attachments and application tools are explicitly unsupported.

**Scope:** Connect selected brand briefs, assets and research to registered tools, and compose the application's brainstorming stages around SDK runs.

**Completion criteria:**

- [ ] A complete brief-to-directions workflow uses authorized project context and streams progress into the existing interface.
- [ ] Proposed names, positioning and identity artifacts are validated and reviewed before becoming accepted project data.
- [ ] Cancellation, resumable app checkpoints and capability differences are visible; unsupported CLI features fail before work starts.

**Depends on:** [AD-033](#ad-033), [AD-007](#ad-007), [AD-008](#ad-008), [AD-010](#ad-010)

<a id="ad-035"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042712)

### AD-035 — Finish LitAgent connection settings and refreshable driver discovery

**Target:** agentic-literature-review · **Component:** Applications · **Phase:** Alpha · **Priority:** P0

**Current state:** The server discovers configured driver instances at startup, uses existing provider settings and saves returned text as proposed cache artifacts.

**Scope:** Add connection management and catalog refresh without restart, plus actionable health and account/model selection in the existing provider settings.

**Completion criteria:**

- [ ] A permitted remote instance can be connected, refreshed, enabled and disabled through existing application controls.
- [ ] A live evidence-backed question completes with interruption, errors and usage mapped to LitAgent's lifecycle.
- [ ] Secrets stay server-side and cached adapters immediately respect settings changes; canonical research files remain behind the app's acceptance flow.

**Depends on:** [AD-003](#ad-003), [AD-011](#ad-011), [AD-025](#ad-025), [AD-031](#ad-031)

<a id="ad-036"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042720)

### AD-036 — Power resumable literature review stages with evidence-linked tools

**Target:** agentic-literature-review · **Component:** Applications · **Phase:** Beta · **Priority:** P1

**Current state:** The direct Q&A path supplies indexed evidence, and the standalone SDK demo validates citation IDs against synthetic passages.

**Scope:** Integrate application-owned search, passage retrieval, screening, extraction and synthesis stages using selected evidence and durable app checkpoints.

**Completion criteria:**

- [ ] A review can resume after disconnect/restart without repeating accepted paper processing or writing directly to the canonical library.
- [ ] Claims link to accessible source passages; citation existence and evidence support are evaluated separately.
- [ ] Metadata, relevance and synthesis changes remain proposals with provenance and acceptance/rejection in LitAgent.

**Depends on:** [AD-035](#ad-035), [AD-005](#ad-005), [AD-008](#ad-008), [AD-010](#ad-010)

<a id="ad-037"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042728)

### AD-037 — Connect AI Workspace triage to a real authenticated mailbox

**Target:** ai-workspace · **Component:** Applications · **Phase:** Alpha · **Priority:** P0

**Current state:** The backend produces schema-validated summaries, priorities, reply drafts and task suggestions through a Mailbox interface; its demo uses synthetic messages.

**Scope:** Implement an application-owned mailbox connector and minimal persisted thread store, with user consent, credential storage and subject/thread authorization.

**Completion criteria:**

- [ ] An authenticated user processes a real selected thread and receives a validated summary, draft and task proposal.
- [ ] Cross-user thread access, identity overrides and email prompt injection cannot grant extra tools or send messages.
- [ ] Mail synchronization and provider authentication remain application services; the shared SDK sees only authorized context and tools.

**Depends on:** [AD-017](#ad-017), [AD-025](#ad-025), [AD-029](#ad-029)

<a id="ad-038"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042736)

### AD-038 — Build AI Workspace review and approved action workflows

**Target:** ai-workspace · **Component:** Applications · **Phase:** Beta · **Priority:** P1

**Current state:** Triage returns proposals only; there is no inbox UI, approval flow, send/archive operation or durable background processing.

**Scope:** Add an inbox review surface and application-owned tools for explicitly approved drafts, tasks and message actions.

**Completion criteria:**

- [ ] A user can edit and approve a draft or action with a preview of exact recipients, content and affected messages.
- [ ] Retries or reconnects do not duplicate sending, task creation or archive operations; actions have an audit trail.
- [ ] Background triage can resume and cancel, while sender content never supplies authorization for external actions.

**Depends on:** [AD-037](#ad-037), [AD-005](#ad-005), [AD-006](#ad-006), [AD-007](#ad-007)

<a id="ad-039"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042746)

### AD-039 — Create end-to-end evaluations for all three application scenarios

**Target:** agenticdriver · **Component:** Quality and security · **Phase:** Alpha · **Priority:** P1

**Current state:** Synthetic examples and integration tests verify contracts, but there is no shared scenario evaluation suite with recorded quality criteria.

**Scope:** Maintain small, reproducible brand, literature and email datasets and optional live-provider runs with application-specific scoring.

**Completion criteria:**

- [ ] Evaluate brand constraint adherence, literature evidence support and email action correctness separately from transport success.
- [ ] Include malicious retrieved text, wrong-tenant access, unsupported capabilities and cancellation during tool work.
- [ ] CI runs deterministic fixtures; paid live evaluations require explicitly supplied credentials and record model/version provenance.

**Depends on:** [AD-002](#ad-002), [AD-033](#ad-033), [AD-035](#ad-035), [AD-037](#ad-037)

<a id="ad-040"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042751)

### AD-040 — Expand CI across operating systems, versions and network failure modes

**Target:** agenticdriver · **Component:** Quality and security · **Phase:** Alpha · **Priority:** P1

**Current state:** CI checks one Ubuntu environment with Node, Python, Go and Rust plus packaged-artifact smoke tests.

**Scope:** Add a declared support matrix and fault-injection checks for hosts, language clients and native process adapters.

**Completion criteria:**

- [ ] Supported OS/runtime combinations validate package installation, protocol conformance and platform-specific cancellation.
- [ ] Proxy buffering, slow consumers, broken streams, TLS failures and disconnect races have reproducible coverage.
- [ ] Fake-clock tests preserve disabled-by-default inactivity behavior; CLI version checks use sanitized fixtures plus opt-in real binaries.

**Depends on:** [AD-002](#ad-002), [AD-025](#ad-025), [AD-026](#ad-026), [AD-027](#ad-027), [AD-028](#ad-028)

<a id="ad-041"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042761)

### AD-041 — Review and test execution, pairing and tenant trust boundaries

**Target:** agenticdriver · **Component:** Quality and security · **Phase:** v1 · **Priority:** P0

**Current state:** The foundation includes explicit allowlists, TLS, origin checks and redaction, but new pairing, tool transports and isolation features need an integrated review.

**Scope:** Document the threat model and run targeted security tests against the supported local, remote and multi-account configurations.

**Completion criteria:**

- [ ] Verify bearer theft boundaries, pairing replay, tenant isolation, tool argument substitution, untrusted content and credential/log leakage defenses.
- [ ] Check host-owned URLs and attachment resolvers against redirect, path traversal and server-side request risks.
- [ ] Record findings and resolve release-blocking defects, with regression coverage and explicit residual trust assumptions.

**Depends on:** [AD-007](#ad-007), [AD-008](#ad-008), [AD-012](#ad-012), [AD-013](#ad-013), [AD-014](#ad-014)

<a id="ad-042"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042775)

### AD-042 — Publish versioned SDK packages and remove sibling-checkout dependencies

**Target:** agenticdriver · **Component:** Releases and docs · **Phase:** Alpha · **Priority:** P0

**Current state:** Package manifests and dry runs exist; the SDK has not been published, and the three applications point at sibling source checkouts.

**Scope:** Set up npm, Python, Go and Rust releases with chosen available package identities, versioning, changelogs and reproducible artifacts; keep one source repository.

**Completion criteria:**

- [ ] Fresh external projects install each released language package and complete a documented mock workflow.
- [ ] Release automation uses scoped publishing credentials or supported trusted publishing, and verifies the packaged contents.
- [ ] Brandstorm, LitAgent and AI Workspace pin a published SDK version and work without a sibling checkout.
- [ ] Document coordinated protocol compatibility even if client packages are versioned independently; registry publication is a deliberate release action.

**Depends on:** [AD-025](#ad-025), [AD-026](#ad-026), [AD-027](#ad-027), [AD-028](#ad-028), [AD-040](#ad-040)

<a id="ad-043"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042783)

### AD-043 — Write SDK onboarding, provider setup and three application recipes

**Target:** agenticdriver · **Component:** Releases and docs · **Phase:** Alpha · **Priority:** P1

**Current state:** README and architecture/provider/application docs cover the foundation; examples require a source checkout.

**Scope:** Create install-first documentation and a documentation site for agenticdriver.dev, with language quickstarts, provider setup, troubleshooting and all three recipes.

**Completion criteria:**

- [ ] Each quickstart is exercised from packaged artifacts and clearly labels synthetic versus live execution.
- [ ] Explain local and remote credentials, actual subscription support, capabilities, optional inactivity and explicit cancellation in plain language.
- [ ] Include an extension guide, compatibility matrix and migration notes; site deployment and domain changes are handled as a separate authorized release step.

**Depends on:** [AD-011](#ad-011), [AD-014](#ad-014), [AD-025](#ad-025), [AD-026](#ad-026), [AD-027](#ad-027), [AD-028](#ad-028)

<a id="ad-044"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042792)

### AD-044 — Complete v1 operational and compatibility release gates

**Target:** agenticdriver · **Component:** Quality and security · **Phase:** v1 · **Priority:** P0

**Current state:** The local foundation is tested, but it has no stable-release support commitment or production workload evidence.

**Scope:** Define and meet explicit v1 criteria for supported providers, clients, deployment modes and application workflows.

**Completion criteria:**

- [ ] Sustained concurrent workloads demonstrate bounded memory, queue behavior, cancellation cleanup and recovery without artificial run deadlines.
- [ ] All three applications complete supported real workflows, with known limitations and provider verification dates recorded.
- [ ] Upgrade/rollback, compatibility, incident diagnostics and support policy are documented; deferred features remain clearly outside v1 guarantees.

**Depends on:** [AD-017](#ad-017), [AD-018](#ad-018), [AD-019](#ad-019), [AD-020](#ad-020), [AD-021](#ad-021), [AD-022](#ad-022), [AD-023](#ad-023), [AD-032](#ad-032), [AD-034](#ad-034), [AD-036](#ad-036), [AD-038](#ad-038), [AD-039](#ad-039), [AD-040](#ad-040), [AD-041](#ad-041), [AD-042](#ad-042), [AD-043](#ad-043)

<a id="ad-045"></a>

[Open in GitHub Projects](https://github.com/orgs/agenticdriver/projects/1?pane=issue&itemId=251042799)

### AD-045 — Investigate an official Grok subscription integration route

**Target:** agenticdriver · **Component:** Providers · **Phase:** Later · **Priority:** P2

**Current state:** Grok is available through the xAI API adapter. No Grok subscription adapter is implemented or verified.

**Scope:** Check current official xAI/Grok interfaces for a supported end-user subscription integration and record the feasibility decision.

**Completion criteria:**

- [ ] The decision cites official authentication and integration documentation and distinguishes availability from speculation.
- [ ] If a supported interface exists, define its adapter, capability and conformance work before advertising support.
- [ ] If none exists, document API-only support; do not scrape browser sessions, extract consumer tokens or imply subscription credits can fund API requests.

**Depends on:** None.

## Retrieval added to the SDK scope

Provide optional RAG and vector database capabilities in the SDK for application-authorized email threads, PDFs and Markdown; applications retain ownership and access control of source content.

### AD-046 — Add scoped RAG, embedding and vector database interfaces

**Scope:** Wire an optional retrieval service into local and remote driver runs with pluggable embedding and vector database adapters, selected collections/documents and bounded passage context.

**Depends on:** AD-010

- [ ] All four language clients can request retrieval from an explicitly authorized corpus or selected document/thread set; tenant and source access are enforced before search and before exposing passages.
- [ ] Embedding model, account, dimensions, similarity metric and index version are explicit; incompatible indexes fail clearly and changing a generation model does not silently change the embedding model.
- [ ] At least one persistent vector database adapter and a deterministic test adapter support indexing, similarity search, filtering, deletion and cancellation through the driver.
- [ ] Retrieved evidence carries stable source/chunk identifiers and citation locations; untrusted retrieved instructions cannot grant tools or widen corpus access.

### AD-047 — Index PDF, Markdown and email context with traceable revisions

**Scope:** Provide reusable ingestion and chunking for application-supplied PDFs, Markdown and email messages/threads, with extraction adapters and application-owned source references.

**Depends on:** AD-046

- [ ] PDF pages, Markdown sections and email message/thread provenance survive chunking and retrieval; scanned PDFs clearly require an explicitly configured OCR adapter.
- [ ] Incremental reindexing deduplicates identical revisions, atomically replaces changed content and removes deleted or revoked sources from retrieval.
- [ ] Parsing, embedding batches, document sizes and context assembly are bounded; malformed documents, empty extraction, cancellation and failed partial indexing have tested outcomes.
- [ ] Embedding usage is attributed to its explicit provider/account and reported to Usagestat without mixing it with generation measurements.

### AD-048 — Exercise grounded questions in all three applications

**Scope:** Integrate and demonstrate selected-context RAG in Brandstorm, LitAgent and AI Workspace while retaining domain data and permissions in each application.

**Depends on:** AD-047, AD-033, AD-035, AD-037

- [ ] Brandstorm answers from chosen briefs/brand documents, LitAgent answers from selected PDF/Markdown evidence, and AI Workspace answers from chosen email threads with navigable citations.
- [ ] Cross-tenant and unselected-source leakage, revocation/deletion, stale revisions, insufficient evidence and fabricated citation identifiers are covered by shared evaluation fixtures.
- [ ] A reproducible local/remote example uses a persistent vector store and documents embedding/provider choices, ingestion, queries, updates and cleanup without requiring a particular generation vendor.

## Grok Build work identified by AD-045

The [2026-09-21 feasibility review](validation/grok-subscription-2026-09-21.md) found an official native integration route. These optional items separate adapter implementation from live account certification.

<a id="ad-049"></a>

### AD-049 — Implement a restricted official Grok Build session adapter with fixtures

**Target:** agenticdriver · **Component:** Providers · **Phase:** Later · **Priority:** P2

**Current state:** AD-045 found official Grok Build headless/ACP and native sign-in interfaces. No SDK session adapter is implemented.

**Scope:** Implement the documented official CLI route with explicit host-owned account/model selection, restricted execution, progress, cancellation and packaged synthetic conformance. Keep live certification separate as AD-050.

**Completion criteria:**

- [ ] A pinned official binary uses its native sign-in and explicit model; no consumer token extraction, ambient API-key/endpoint fallback, or unrequested native tools execute.
- [ ] Fixture tests prove incremental visible output, redacted errors/private reasoning, truthful usage, process cleanup, explicit cancellation, and disabled default inactivity; document or reject incompatible native limits.
- [ ] Effective native configuration, permissions, hooks/MCP/plugins/skills/memory and session storage are bounded and verified read-only without changing the user account configuration.
- [ ] The installed adapter passes packaged conformance and shared language transport checks, with capabilities and OS limitations recorded; fixture success does not advertise live account certification.

**Depends on:** [AD-024](#ad-024), [AD-045](#ad-045)

<a id="ad-050"></a>

### AD-050 — Certify the Grok Build session route on an explicitly selected account

**Target:** agenticdriver · **Component:** Providers · **Phase:** Later · **Priority:** P2

**Current state:** Official documentation establishes an integration route, but no account or model has been selected for Grok live checks.

**Scope:** Recheck official integration/authentication requirements and verify the restricted session adapter using an explicitly selected account/model and synthetic input before listing live support.

**Completion criteria:**

- [ ] An explicitly selected account/model completes a synthetic run with recorded native version, OS, authentication route, progress, final result and known or unknown usage.
- [ ] Cancellation, native policy enforcement, credential isolation, missing/expired sign-in and model/quota failures have evidence or specific documented limits; no fallback or destructive account changes occur.
- [ ] Provider documentation and the supported matrix distinguish observed account eligibility, consumer usage pools and separately configured developer API billing; no unsupported subscription-credit claim is made.

**Depends on:** [AD-049](#ad-049)
