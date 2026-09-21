# Grok subscription integration feasibility

Reviewed 2026-09-21 for AD-045. **An official application-integration route exists:
Grok Build.** Its documented headless and ACP interfaces make a local session
adapter feasible. This is a documentation finding, not a working SDK adapter or
live account certification. AgenticDriver currently implements Grok through its
API-key `xai()` adapter only. [Grok Build overview](https://docs.x.ai/build/overview)

## Evidence and limits

| Official source                                                                                                         | What it establishes                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Headless and scripting](https://docs.x.ai/build/cli/headless-scripting)                                                | Headless JSON/streaming JSON and `grok agent stdio` for ACP over JSON-RPC; an example integrates an already authenticated CLI into another application.                                                                     |
| [Enterprise authentication](https://docs.x.ai/build/enterprise#authentication)                                          | Browser login, device-code login, external identity providers and API keys are distinct supported routes. Credential precedence includes per-model keys before a saved session.                                             |
| [Grok usage FAQ](https://docs.x.ai/grok/faq#usage--limits)                                                              | The consumer weekly allowance includes Build; its usage breakdown also mentions API. This is product-level eligibility information, not proof of an individual account's model access or a credential-conversion interface. |
| [API account FAQ](https://docs.x.ai/console/faq/accounts) and [API quickstart](https://docs.x.ai/developers/quickstart) | The sign-in account can be shared, while the developer API has separate billing and API-key setup.                                                                                                                          |
| [Official source repository](https://github.com/xai-org/grok-build)                                                     | Source and released native CLI distribution exist; first-party source is Apache-2.0. A source license does not confer access to the hosted inference service.                                                               |
| [CLI reference](https://docs.x.ai/build/cli/reference)                                                                  | Explicit model selection, tool restrictions and feature controls are documented. Availability of a flag alone does not verify its effective behavior in a particular binary.                                                |
| [Settings reference](https://docs.x.ai/build/settings/reference)                                                        | `GROK_HOME` selects native configuration/auth/session storage. Model endpoints, retry/idle settings and compatibility scanners can affect execution.                                                                        |
| [Sandbox](https://docs.x.ai/build/features/sandbox) and [permissions](https://docs.x.ai/build/features/permissions)     | Permissions and OS isolation are separate; sandboxing defaults off and documented platform limitations matter.                                                                                                              |

The consumer allowance and separate developer-billing pages describe different
surfaces. We cannot infer that a saved consumer token works at `api.x.ai`, that
all tiers have the same entitlements, or that an API key consumes included Build
usage. A future adapter must report its selected native route and leave unknown
usage unknown. No Grok sign-in, credentials or live inference were exercised in
the documentation review or the isolated compatibility test below.

Consumer credentials must remain with their owner; the
[consumer terms](https://x.ai/legal/terms-of-service) restrict sharing accounts.
The [enterprise terms](https://x.ai/legal/terms-of-service-enterprise) describe
API integrations for customer applications under the applicable agreement. Our
engineering decision is to invoke the official CLI on the user's execution host;
it does not establish permission to pool consumer accounts in a hosted service.

## Implementation decision

Track fixture implementation as [AD-049](../roadmap.md#ad-049) and live account
certification as [AD-050](../roadmap.md#ad-050). Both remain outside the current
supported provider matrix until their evidence exists. The existing xAI API
validation and Responses work remains AD-020; it is not a subscription fallback.

The proposed `grokBuild` adapter uses a host-selected released binary, an explicit
model allowlist and a dedicated native account directory. Prefer ACP to carry
prompts over stdin without putting user content in process arguments. Pin and
probe the binary/protocol version. If required controls are absent, fail with a
fixed unsupported-version/policy diagnostic before inference.

Keep authentication in official `grok login` / `grok login --device-auth` flows,
performed explicitly by the account owner. Do not implement consumer OAuth,
read/copy native tokens, scrape a browser, call an undocumented proxy, or initiate
sign-in from an application run. Exclude ambient API keys and endpoint overrides.
Verify effective native configuration so a per-model key cannot change the
selected session route. Discovery may check supported native status/model
commands, but must not trigger generation or equate a cached session with access.

The first implementation is restricted text execution: `authMode: cli-session`,
`tools: false`, and native cross-run continuation disabled. Enable
`textStreaming` only after verifying incremental visible message chunks. Map
private reasoning to progress without exporting content. Text/Markdown and
driver-assembled RAG remain ordinary prompt context. Native application tools,
media, durable native sessions and ACP filesystem/terminal callbacks need
separate capability work; do not advertise them from Grok Build's broader feature
set.

The host must prevent ambient hooks, MCP, plugins, skills, instructions, memory,
subagents, web tools, session sharing and update checks from introducing work.
Use an empty working directory and bounded stdio; reject ACP permission or
filesystem/terminal requests outside the selected restricted contract. Verify
effective managed policy without modifying the user's native configuration.
Process-tree termination and account/file isolation must be verified for each
advertised OS. The documented native sandbox alone is insufficient evidence.

There is no SDK run-duration deadline or default inactivity timeout. The CLI's
[enterprise network documentation](https://docs.x.ai/build/enterprise#proxy-support)
describes a default 600-second inference idle limit. AD-049 must determine and
test a supported disabled-idle setting, distinguish it from pool/discovery
timeouts, and expose any unavoidable native limitation explicitly. Never silently
adopt a native default as the SDK's inactivity policy. Also disable native retries
and fallback paths unless explicitly selected and compatible with SDK semantics.

## Acceptance work

AD-049's subprocess fixtures must cover version negotiation, explicit model and
account binding, visible streaming, malformed/missing terminal frames, native
failures, usage coverage, cancellation/process cleanup, disabled/default versus
explicit inactivity, rejected unrequested tools, ambient configuration and
credential redaction. Run the packaged extension checks and shared language
transport suite. Native policy probes must stay read-only and avoid inference.

AD-050 then selects an account and model explicitly, uses synthetic input, and
records native version, OS, route, first progress, terminal output, cancellation
and measured or unknown usage. Include expired/missing sign-in, quota and model
rejection evidence where it can be obtained without destructive account changes.
Do not close live acceptance using mocked transcripts. Recheck official
authentication, integration and billing documentation at certification time.

## Native compatibility probe on 2026-09-21

**AD-049 remains open.** The official stable Linux x64 binary reports
`grok 1.0.40 (eb1a2256660d)`. The downloaded artifact is 165,587,968 bytes with
SHA256 `92c997dfd109c0672d40d5ae6fbd15835d53ffaf12cf9ea124d22aaef3ff23fc`.
It came directly from [xAI's release endpoint](https://x.ai/cli/grok-1.0.40-linux-x86_64);
the installer was not executed and no native credentials were accessed.

The separate [public source export](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs)
uses `per_model.or(remote).unwrap_or(600).max(10)` when resolving inference
inactivity. Its export commit is `4247f661689354b831191f11eeeac8424993fe3d`, with
source revision `9bb727ccdff0a793ee73bcde4e2e09cbef6b5387`. These are source evidence;
they are not an assertion that this public commit built the released binary.

The binary ran in a non-root, read-only Docker container with no external
network or user-account mounts. A temporary native config selected a loopback
synthetic model endpoint, disabled retries/remote config/telemetry/updates,
and set both global and per-model `inference_idle_timeout_secs = 0`. The fixture
sent one text chunk, then stayed silent:

| Observation                                        | Result                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Main request                                       | Explicit `sdk-fixture` model; zero tools                                    |
| Inference connection closed                        | 10,004 ms after the stream began                                            |
| Native process                                     | Exit 1 after 10,362 ms; `idle_timeout`, stopped responding after 10 seconds |
| Independent 25-second test watchdog                | Did not fire                                                                |
| Live provider account, sign-in or billed inference | None                                                                        |

Other controls also need attention. `--tools ""` selects the native default
tool set. Explicit exclusions need canonical IDs such as `run_terminal_cmd`,
`kill_task` and `get_task_output`, rather than their renamed wire aliases. With
those exclusions the fixture verified zero model-request tools. A separate
`session_title` inference was still attempted with recap, turn summary and title
refresh disabled; setting `models.session_summary` bound that side call to the
fixture model, and the local peer rejected it. No tool executed.

A separate no-prompt inspection found that the documented Cursor/Claude scanner
switches alone do not suppress every ambient plugin/skill surface. No discovered
hook, MCP server or plugin was executed. The generation probe had no access to
those host directories.

The adapter still needs a supported disabled-idle contract, control of native
side work and ambient policy, and packaged conformance. A separately explicit
native-limit mode would need its own design and must be rejected by default;
zero must never silently mean a positive SDK timeout. This evidence establishes
a binary compatibility limit, not account certification. The implementation
issue retains the [probe record](https://github.com/agenticdriver/agenticdriver/issues/32#issuecomment-5759978439).
