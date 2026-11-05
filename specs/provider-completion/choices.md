# Provider completion choices

## Sound — medium confidence: explicit Claude tool mode replaces blanket safe mode

Safe mode disables even the explicitly configured application MCP helper. The
text default retains it. Tool opt-in instead excludes filesystem settings,
built-in tools, inherited MCP, slash commands and Chrome; hooks, memory and
fallback are disabled. The SDK checks the exact owned runtime inventory, and
application callbacks remain under the existing SDK approval pipeline. A native
zero-prompt check observed the one owned MCP tool and no project hook or MCP
canary effect. Managed administrator policy is still part of the trusted host.

## Sound — high confidence: one proposal bridge, no application effects in native MCP

Codex and Claude share the private proposal transport/helper. Their native
protocol parsers map to that owner. A proposal must have matching native and
helper evidence before native execution is stopped and the SDK receives it.
The helper never executes or returns application results. Late authenticated
malformed transport invalidates a batch even after an interrupt was requested.
Only the exact expected interruption can return a proposed batch; parser,
output-limit and policy failures remain failures.

## Sound — medium confidence: portable Claude continuation is explicit application history

Each tool step closes its native process before application approval/effects.
The next ephemeral Claude process receives application messages, tool IDs,
arguments and completed results as a labelled JSON transcript, without private
native state. This avoids an unbounded native process waiting through approval
and does not claim native session resumption or native API-role injection.

## Sound: error precedence and generated configuration contracts

An unexpected native operation must remain a failure even when a delayed
tool confirmation subsequently requests normal proposal shutdown. Process
cancellation preserves an existing failure; a parser failure arriving after
the expected shutdown also remains authoritative. Generic process regressions
cover both event orders without a model substitute.

Claude's optional tool setting is represented in the generated host and
management schemas as well as runtime validation. The schemas come from the
existing Zod owners; no parallel client representation is introduced.

## Sound — medium confidence: explicit native API billing is a separate connection

The native Claude runtime is useful with either a subscription sign-in or an
explicit API credential. A strict configuration union selects one mode; the API
variant cannot name a native account directory or endpoint override. An existing
instance cannot change modes through management. This preserves account/usage
identity and prevents a failed key from silently using a signed-in subscription.
The existing secret resolver owns credentials; no new auth store is introduced.

API operations use a fresh private home, bare runtime startup, and explicit
credential environment. Authentication must report `api_key`. The proposal helper
receives an empty API-key environment. Actual zero-prompt native checks observed
both the intended authentication method and owned MCP isolation. The separate
installed application receipt demonstrates execution without repairing native
subscription access. Usage stays `cli-report`, with `authMode: api-key` and
native cost-estimate limitations. Host/factory/CLI support ships first; a guided
setup method remains a separate interface task.

API feature checks belong to the current operation's private home and caller
signal, not a cached promise holding another operation's environment. Version
and help subprocesses receive no API credential. This also keeps first-call
cancellation on the existing process-reaping and profile-cleanup path.
