# Claude application-tool implementation and readiness

This is unreleased implementation/readiness evidence, not a successful real
Claude tool run or consumer application acceptance. No inference was submitted.

The implementation adds explicit `applicationTools: "mcp"` to Claude Code's
factory/host configuration. It reuses the proposal-only MCP owner with Codex;
SDK callbacks, validation and approvals remain outside native MCP. A matched
native/helper proposal interrupts and reaps the CLI before the SDK can execute
an application effect. The next ephemeral process receives portable application
history with tool-call IDs/arguments and completed results, without private
native session state. Native tools remain disabled by default.

## Actual native controls

The selected existing Prometheus binary reports **Claude Code 2.1.282**. Its
actual SDK initialize/control protocol was inspected without sending a user
message. With blanket safe mode, even an explicitly supplied MCP server was
absent. Removing that blanket while retaining restricted mode, empty setting
sources, empty built-in tools, strict one-server MCP, no slash/Chrome/permission
prompts and hook/memory/fallback controls yielded exactly the owned connected
MCP server and selected `read_release_notes` tool. Project hook and project MCP
canaries remained absent. These checks used the production owned proposal
helper, never a fake model endpoint or canned inference response.

The native [CLI reference](https://code.claude.com/docs/en/cli-reference) defines
these controls. Managed administrator policy is still part of the trusted host;
this is not an operating-system isolation certification. The implementation
pins this reviewed version and rejects unexpected initialization inventories,
permission requests, native tools, unmatched/duplicate proposals, parser failures
and malformed owned helper traffic.

## Installed-archive preflight and blocker

Candidate source `4b39458f0c0d905278e34cb472dc7cc6bba071a1` was built and packed,
then installed into a fresh private Prometheus consumer with Node **24.16.0**.
Archive SHA-256:
`2398fb621ff8f73c9dfc6e03533682006fe6e26fa99fcd22db0ecd0d0510fc9e`.
The candidate's current installed preflight stopped at account inspection:
**signed-out**, with zero submitted SDK runs, zero tool calls and no retained
host. The saved source configuration matched its starting hash. Private
preflight receipt SHA-256:
`478f1bba55d3063a9f2158742d4685ac6a54a3f03318e69f4acb05125653cc34`.
The fine-control native metadata receipt SHA-256 is
`0677ad2b1142126cbf5416e1f555208e4f67334ec9b11fff2880028f18acde17`;
full metadata and private paths remain on the execution host.

A direct read-only native check independently confirmed exit 1,
`loggedIn: false`, `authMethod: none`, and the exact selected account directory.
No credentials were read by the qualifier, exported or replaced. No login,
alternate account/model, API billing, provider fallback or service mutation was
attempted. The intended model remains **claude-haiku-4-5-20251001**; current model
availability and execution are not inferred from historical catalog receipts.

A later review corrected process error precedence and regenerated the host
configuration protocol. The archive above is therefore a historical refused
preflight, not qualification of that revised runtime. After the account owner
restores the selected native sign-in, build a fresh immutable archive and use
one bounded SDK run with at most two model steps. It must actually call the
selected public-release-note tool, incorporate its exact source hash/facts in
an email draft, and report actual usage. Denial and cancellation evidence must
be labelled by what was exercised; no inference was run to establish them here.
