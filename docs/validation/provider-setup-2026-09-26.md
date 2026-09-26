# Guided provider setup validation — 2026-09-26

Scope: [AD-053 / #49](https://github.com/agenticdriver/agenticdriver/issues/49).
The host setup catalog and shared component were exercised without model calls.
Native browser/device sign-in remains separate work in #50.

## Automated checks

- `npm run check`: typecheck, 325 tests and shared component build passed.
- `npm run protocol`: regenerated the management definition schema.
- `npm run test:clients`: TypeScript, installed Python, Go and installed Rust
  clients passed against HTTP and certificate-verified HTTPS hosts. Blocking and
  async clients preserve setup metadata; all three runnable language panel
  examples passed their asset, setup, mutation and disconnect checks.
- `npm run test:install`: the packed npm SDK, executable CLI, public exports,
  browser-only type/bundle checks and independent consumer installation passed.
- `npm run build --prefix site`: documentation site passed.

Tests cover management grants, stale revisions, unchanged execution permissions,
all-model versus empty-allowlist semantics, no native process or secret resolution
on setup metadata reads, invalid definition rejection, older-host snapshots,
and preservation of Codex's `applicationTools: "mcp"` setting when saving through
language clients. These checks use synthetic credentials and local fixture peers.

## Browser checks

The shared component was checked in the native T3 collaborative browser at
1920×1080 and 390×844. A separate private fixture host and loopback model-catalog
peer were used; regular LitAgent, its usage service and existing provider accounts
were untouched.

- Provider search retained keyboard focus and caret while filtering. Searching
  for Grok offered the two supported xAI API protocols.
- Native setup showed the selected host, official credential ownership,
  version/setup requirements and a safe documentation link. It did not start
  sign-in or a native runtime.
- Compatible endpoint setup required a key or explicit host credential reference.
  A synthetic key was stored in a mode-0600 file, absent from host configuration,
  responses and browser storage, and cleared from the input after saving.
- Switching from an empty file reference to a new API key saved correctly.
  Choosing another provider action did not send a pending replacement key to
  that provider. Repeated provider kinds received distinct instance IDs.
- The saved fixture gateway reported both catalog models with all-model access;
  the management-only client's model-selection buttons remained disabled.
  Reload retained the saved connection.
- Older-host responses without `providerDefinitions` retained the original
  supported-kind settings form. Unknown future interactions remained disabled.
  Injected markup was rendered as text and a non-HTTPS help URL was omitted.
- The narrow layout had no horizontal document overflow; the provider strip
  scrolls independently.

T3's text snapshot/type helpers did not traverse editable fields in the component's
open shadow root. Checks used the same T3 browser's DOM inspection, click and key
tools; long synthetic field values were entered through its DOM evaluation tool.
Screenshots were inspected at both widths. No alternative browser runtime was used.

The two independent fixture sessions each observed model-catalog GETs and **zero
inference requests**. These results establish setup behavior, not live gateway
compatibility, account entitlement or model qualification.
