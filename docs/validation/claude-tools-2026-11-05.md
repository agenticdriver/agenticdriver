# Claude application-tool implementation and readiness

This records unreleased implementation, a refused subscription preflight and a
successful separately selected API-billed native application run. Each receipt
applies only to its recorded source, connection and model.

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

## Explicit native API-mode controls

A separately authorized API-billed native connection now uses a fresh private
home and the host's existing secret resolver. Its credential remains on the local
execution host; it was not copied to Prometheus or used to repair that native
profile. The initial controls below submitted no model prompt; subsequent
installed-package execution is recorded separately.

The local probe used the separately installed official Linux x64 Claude Code
**2.1.282** binary; the existing global runtime was preserved. Executable SHA-256:
`3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3`.
With the actual selected credential, native `--bare auth status --json` reported
**signed-in / api_key** in the isolated home. The API credential was absent from
native login-helper environment channels. An initialize/control-only MCP probe
observed exactly the connected owned `read_release_notes` tool. Inspection of
that probe's owned helper process confirmed its API-key environment was empty.
Neither probe sent a user message; both record **zero model requests**. These
are source/control checks, not immutable installed-package application acceptance.

## Installed API-mode application acceptance

A fresh consumer installed the exact development archive from source
`7527b98bddc266bcdf5a2f80b6195ef6f0d482c0`, SHA-256
`48fc33a6510e20ebd117927cbe02650483224b43be8f3c1ff158357731fbfd05`.
It used the pinned official **Claude Code 2.1.282** binary above, explicit
**API-key** authentication and **claude-haiku-4-5-20251001**, verified in the
current native catalog. This did not reuse or repair the subscription profile.

One SDK run, bounded to two model steps, called the real `read_brand_brief`
application tool exactly once. The SDK approval occurred before the callback;
no owned native CLI/helper descendants remained at either boundary. The next
native step received the actual tool result through portable application history.

The brief described an 18L repairable Amsterdam commuter backpack for ages
25–40, recycled fabric, replaceable buckles and a €120–160 price range. The model
produced three distinct names/taglines/positions and retained the exact source ID
and claim limits. Parent review accepted the grounded brainstorming artifact;
these remain creative proposals without trademark clearance. The response used
a Markdown JSON fence despite the compact-JSON instruction, so consumers needing
strict JSON must validate output format.

Reported usage was **2,271 input / 1,159 output / 0 cached tokens**, with both
steps covered. Usage is `cli-report`, with `authMode: api-key`. Only the final
step reported an API-equivalent cost estimate, so full-run cost is unknown.
There were no retries. Owned processes and temporary operation directories were
removed. Pre-submission SDK cancellation passed with zero model steps; this run
did not establish real approval denial or cancellation during active inference.

Private acceptance receipt SHA-256:
`d6c3bc2bea68dfc7477ce8db03a8861dddfe02858114372cdf5ce7192667dc9b`.
Brand artifact SHA-256:
`59058ab0194cf31d39f43d2ab76cd9f3da9eefb5e5e4e038c51ed8ef52d9fec6`.
Preflight SHA-256:
`76adf9a598714a2021e229db4f0f31ef108b6bc8a5f60c9e33acc9be8ea52f29`.
Installed MCP control SHA-256:
`35db7c3742f9c73e17a4acf7eb518d52b222879406b70945ba8d3ae33232a7f9`.
