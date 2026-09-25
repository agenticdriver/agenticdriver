# Codex native application-tool protocol audit — 2026-09-25

This audit completes [the protocol characterization task (#40)](https://github.com/agenticdriver/agenticdriver/issues/40).
It does **not** complete [AD-009 (#39)](https://github.com/agenticdriver/agenticdriver/issues/39)
or enable application tools in the production Codex adapter. Its capability
remains `tools: false`. No live account, provider key, or subscription was used.

## Reproduce

Install the complete official Linux Codex 0.157.0 native bundle, Node.js 22.13+
and bubblewrap, then run:

```sh
npm ci
npm run build
python3 scripts/test-codex-native.py --suite tools \
  --binary /absolute/path/to/native/codex --receipt /tmp/codex-tools.json
```

The binary must have its adjacent `codex-code-mode-host` helper. The launcher
hides the user's home and temporary directory, isolates process and network
namespaces, and creates synthetic credentials. Its local Responses endpoint
returns predetermined tool calls and usage. The report includes hashes of the
binary, helper, fixture and SDK process runner, plus the source commit and
dirty-state flag. Twenty-second scenario and 120-second suite watchdogs apply
only to this test infrastructure.

Prometheus CI runs both `--suite adapter` (the existing production adapter
checks) and `--suite tools` in a container with external networking disabled.
The image verifies the qualified native binary and helper hashes. CI uploads
both JSON receipts as `codex-native-contract-receipts`.

## Observed native behavior

| Scenario                                         | Result                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dynamic tool success                             | A registered synthetic passage tool is called once. Its result reaches the next native model request. Two fixture generations report 22 input and 10 output tokens in total.                                                                                                                                             |
| Dynamic tool denied with JSON-RPC error          | No application effect executes, but Codex converts the error into a tool result and makes another model request. A client error alone does not stop its agent loop.                                                                                                                                                      |
| Interrupt while awaiting the dynamic tool result | No tool response is submitted. The native turn becomes interrupted, reports the first completed fixture generation's 11 input and 5 output tokens, and makes no second model request.                                                                                                                                    |
| MCP tool with an explicit 0.25-second timeout    | The synthetic server emits progress while its response is pending. Codex times out the tool and continues to another model request. The receipt distinguishes server-emitted progress, a requested progress token, and native progress notifications; emission alone does not prove the client recognizes that progress. |

The dynamic success and denial traces have this order:

```text
first model request
client tool request
client tool response
usage notification
second model request
usage notification
```

Usage for the current generation is therefore unavailable at the first tool
request in these fixtures. The subsequent generation starts inside Codex,
without a new SDK provider invocation. The interruption fixture receives usage
because its synthetic generation has already finished; this is not a guarantee
that interrupting a live stream recovers complete usage.

The ambient MCP server in the synthetic account is explicitly disabled and
never starts. All native and MCP child processes are reaped. Dynamic mode
retains Codex's calculation/clock catalog. MCP mode also advertises native MCP
resource helpers and makes the selected MCP tool available through code mode.
This is not an empty native tool catalog or a general OS-isolation certification.

## Consequences for the SDK bridge

The existing driver validates the complete tool batch, checks reported usage,
obtains approval and executes application tools between provider invocations.
It also authorizes each subsequent SDK model step. Calling tools directly from
an app-server callback would bypass parts of that sequence unless the native
loop is explicitly integrated with it.

The implementation must preserve those guarantees, including remote application
tool tickets, cancellation and uncertain-effect handling. Denial must stop the
native run, not merely send an error response. Missing usage must remain unknown
and respect the configured unknown-usage policy. Native internal generations
must not be presented as individually authorized SDK steps.

An interrupt-and-handoff design is a candidate: stop the native turn before
any application effect, return validated proposed calls to the existing SDK
loop, then supply their completed results in the next invocation's history.
It still needs real adapter implementation and tests for concurrent calls,
incomplete usage, history fidelity, approval, cancellation and live attribution.
This audit does not certify that design or replace AD-009's MCP scope.

Codex documents a 60-second default MCP tool timeout. The pinned source always
supplies a duration when one is omitted; its active-time timer pauses for
elicitation, rather than implementing the SDK's progress-reset inactivity
policy. Enabling MCP must not silently introduce that limit into application
tool execution. The SDK's default inactivity timeout remains disabled.

The protocol and timeout contracts are documented in the official
[app-server reference](https://learn.chatgpt.com/docs/app-server),
[MCP settings](https://learn.chatgpt.com/docs/extend/mcp),
[native dynamic-tool response handling](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/app-server/src/dynamic_tools.rs),
[MCP connection manager](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/codex-mcp/src/connection_manager.rs), and
[MCP active-time timeout implementation](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/rmcp-client/src/rmcp_client.rs).
