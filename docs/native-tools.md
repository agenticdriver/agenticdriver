# Native application tools

Development source supports opt-in application tools with **Codex CLI 0.157.0
on Linux x64**. The registry's original SDK 0.1.0 predates this feature. Other
native adapters and the default Codex configuration remain text only.

```ts
import { codex } from "@agenticdriver/sdk/providers";

const provider = codex({
  id: "my-codex",
  binary: "/opt/agenticdriver/codex-0.157.0/bin/codex",
  accountDirectory: "/private/selected-codex-account",
  applicationTools: "mcp",
  reasoningEffort: "medium",
});
```

The same `applicationTools: "mcp"` setting is accepted on a Codex provider in
host JSON or a revision-checked `configureProvider` request. It enables the
adapter's `tools` capability. Register and select tools through the existing
[application-tool contract](application-tools.md) and grant remote callers the
required tool and approval scopes. Changing a provider does not grant callers
new authority. Select the provider, account and model explicitly as usual.
Use a versioned executable path: automatically replacing a global CLI can make
the connection unavailable until that version passes native qualification.

The helper exposes only the requested tool definitions. Its MCP calls record
proposals and perform no application effects. The SDK matches each native call
to its helper confirmation, interrupts the native turn, collects reported usage,
and reaps native processes before returning the proposed batch. Unconfirmed,
duplicate or unexpected protocol records fail the batch. Loopback proposal
transport uses a private per-invocation credential; the manifest is mode 0600
inside a private temporary directory and is removed after use.

The normal SDK pipeline then checks usage/resource policies and the **whole
batch** of tool arguments before asking for approval or invoking any callback.
Remote execution tickets, idempotency and uncertain-effect handling retain their
existing behavior. Denial stops the SDK run rather than returning a tool denial
to a continuing native model loop. Missing native usage remains unknown and
stops execution when the host's resource policy requires known usage.

After an approved tool returns, the next model step uses a fresh ephemeral
native thread and explicit JSON conversation history containing call IDs, tool
names, arguments and results. This is portable application history, not native
thread resumption. The native MCP timeout covers proposal transport only;
application work and human approval happen after that native process has closed.
There is no default application-tool, approval, run or inactivity deadline.

Inherited MCP servers, hooks, plugins, agents and local execution capabilities
remain disabled by the qualified adapter controls. Codex's internal sandboxed
JavaScript, clock and MCP metadata operations remain native utilities; they are
not SDK application callbacks. Global native instructions/skill descriptions can
still enter context, and these controls are not an OS isolation boundary. Keep
untrusted tenants in separate restricted host processes/containers. Native CLI
retries and provider-side limits retain the limitations in [provider setup](providers.md).

The [offline native report](validation/codex-application-tools-2026-09-26.md)
records verified behavior. Capability availability does not qualify every model
or account, and no fallback is introduced.
