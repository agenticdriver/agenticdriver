# Provider and connection component

AgenticDriver includes one framework-neutral web component, `<agenticdriver-providers>`, with backend bindings for TypeScript, Python (sync and async), Go, and Rust (blocking and async). Each language package contains the same browser module. Web apps and desktop webviews can embed it without installing a second provider runtime or a JavaScript framework.

These additions are packaged in the [0.2.0 alpha](alpha.md); the published 0.1.0 packages predate them. Pin the exact alpha and check host capabilities before enabling management controls.

## Try the complete setup flow

From a built SDK checkout, open the panel:

```sh
npm ci
npm run build
node dist/cli.js panel --connection "$PWD/.private/desktop-connection.json"
```

Open the private loopback link it prints. The link carries an ephemeral panel access key in its fragment; the page removes the fragment and retains that key only in this browser tab’s session storage. Restarting the panel invalidates it. This key is separate from the long-lived host credential, which remains on the backend. The disconnected panel explains local and remote setup. For a local Codex account, run this in another terminal:

```sh
node dist/cli.js setup --provider codex --manage --config "$PWD/.private/host/config.json"
```

Paste its one-use invitation into the panel. The backend exchanges it and saves a private connection profile and separate credential file. Leave both processes running. Existing hosts use `agenticdriver pair` with the existing config; `setup` creates a fresh config and will not overwrite one. Use the actual installed native executable with `--binary` and account directory with `--account-directory` when required by your provider installation.

For another machine, its operator starts an HTTPS host and supplies an invitation containing its reachable URL. See [local and remote connection setup](connections.md) for TLS, scopes, expiry, revocation, existing hosts and exact commands. A hosted application's backend must be able to reach that URL; its `127.0.0.1` refers to the server, not the person using the browser. The standalone panel binds only to loopback. Embed the component in your existing authorized settings page when serving remote browsers.

## Runnable language examples

After building the shared asset with `npm run build`, each language can serve the same panel with its own backend:

```sh
# Python (inside your virtual environment)
python -m pip install ./clients/python
python clients/python/examples/provider_panel.py

# Go
(cd clients/go && go run ./examples/provider-panel)

# Rust
cargo run --manifest-path clients/rust/Cargo.toml --example provider_panel
```

Each prints a private loopback URL. Open it and paste a host invitation, just as in the standalone panel. These small examples keep the exchanged host credential in backend memory and forget it on shutdown; the host grant retains its original expiry until revoked. In a real application, use the existing private secret store and settings authorization. `AGENTICDRIVER_CA_FILE` optionally names a private CA certificate for the selected host; certificate and hostname verification remain enabled. The examples never call a model.

The Go and Python examples use their standard HTTP servers. The Rust example uses [Hyper's HTTP server API](https://hyper.rs/guides/1/server/hello-world/) through development dependencies only; these are not added to the SDK's runtime dependencies.

## What the component owns

- Provider instance list, refresh time, reported health and account identifier.
- Searchable provider picker and guided connection methods reported by the selected host: existing native sign-in, owned Codex device sign-in, write-only API key, host credential reference and compatible endpoint. Account identity, executable paths and other advanced settings remain available.
- Revision-checked remote changes to display name, enabled state, native executable/account directory, reasoning effort, API endpoint and credential reference; API keys are write-only.
- Reported model inventory plus explicitly configured IDs, search, optional model allowlists, and all-model access by default.
- Device-local favorites, visibility and ordering, isolated by connection ID and provider instance.
- Disconnected setup, pairing hooks, invitation creation and connection revocation for authorized managers.

The component does not start inference. A model selection emits `agenticdriver:model-selected` with `{ provider, model }`; the application owns subsequent runs. `agenticdriver:preferences-changed` contains `{ provider, favorites, hidden, order }`. Hidden models remain visible but muted in settings so they can be restored.

Inventory, host configuration and execution grants are distinct. An empty model allowlist denies all models; an omitted allowlist permits any explicitly chosen model. A reported model is not marked live-tested. Managers can see all instances; `management.executionProviders` identifies which they can actually run. Management-only connections cannot select models for execution. Hosts predating that field leave management-side selection disabled until their permissions can be determined. Refresh and settings changes do not cancel active runs.

Provider-native installation, token exchange, storage and refresh remain with the official runtime on the provider machine. Qualified hosts can guide [Codex device sign-in](provider-sign-in.md) from the component. Extension settings remain host-operator owned. This release does not install native binaries or expose arbitrary process arguments/environment variables. Codex device sign-in opens the official provider page in the user's browser. Supported settings match the SDK's qualified runtime adapters.

## Add a provider connection

Choose **Add provider**, search for the provider or gateway, and select its advertised connection method. The panel identifies the connected host before requesting any credentials. API connections accept a key once or reference an existing host environment variable/private file; compatible endpoints also require their URL. Native connections use the official runtime's existing sign-in or an advertised owned sign-in method, with setup requirements shown before proceeding. Expanding **Advanced settings** exposes the instance/account IDs and native executable/account directory.

Saving a connection does not run a model, start provider sign-in or extend any application's execution grant. Model discovery may run afterward and reports its own status. New instances allow all explicitly selected models by default; use **Models** for a connection allowlist. A gateway connection identifies that gateway account, not a guaranteed upstream provider/account; configure upstream routing and billing at the gateway.

Owned sign-in presents its device code, polls caller-owned setup state and requires explicit account confirmation after native verification. It stays available through refresh and can be cancelled without changing shared accounts. The component hides this method when `provider-setup` is absent.

The shared component reads optional `management.providerDefinitions`. Older hosts without that field retain the original `supportedKinds` settings form. All four language packages preserve this metadata and Codex's `applicationTools` setting when configuration is saved. [Provider management](provider-management.md#connection-definitions) documents the typed contract. The [connection design review](provider-connection-design.md) records the T3 Code, OpenCode, gateway and Langfuse references and the native sign-in lifecycle.

## Embed in an existing application

Serve the supplied JavaScript as a same-origin module, insert the supplied HTML in a settings page, and mount the language bridge at its `api` path. The bridge resolves the already-connected SDK client **on the backend for the current application user**. Keep long-lived host credentials and provider keys out of browser bundles, HTML and browser storage.

Use the application's existing settings authorization and CSRF checks on every bridge request, including snapshots, connect, disconnect and mutations. Limit request bodies to 1 MB, return JSON with `Cache-Control: no-store`, and do not log request bodies (they may contain one-use invitations or replacement API keys). The SDK does not add application authentication. A webview may instead assign an application-owned `transport` function using its existing IPC.

The same component can be used in React, Vue, Svelte, plain HTML, server-rendered pages or a desktop webview. It uses an open shadow root. Set `theme="light"` for its light palette; override `--ad-bg`, `--ad-surface`, `--ad-field`, `--ad-line`, `--ad-fg`, `--ad-muted`, `--ad-accent`, and `--ad-good` on the element for application styling.

### TypeScript / JavaScript

```ts
// Backend, within the consuming application's settings route.
import { providerPanel } from "@agenticdriver/sdk/panel";
import { providerPanelHtml } from "@agenticdriver/sdk/ui";

const panel = providerPanel({
  client: () => currentUserDriverClient(),
  connection: () => ({
    id: connection.id,
    label: connection.label,
    url: connection.url,
  }),
  connect: async (invitation) => saveConnectionForCurrentUser(invitation),
  disconnect: async () => forgetConnectionForCurrentUser(),
});

// After your existing settings authorization and CSRF check:
const result = await panel(requestBody);
// Respond with result as no-store JSON.
const markup = providerPanelHtml({ apiPath: "/api/settings/driver" });
```

Import `@agenticdriver/sdk/ui` in your browser entry or serve its compiled module at `/assets/agenticdriver-panel.js`. A custom transport can supply existing application headers/IPC:

```ts
import {
  registerProviderPanel,
  type ProviderPanelElement,
} from "@agenticdriver/sdk/ui";
registerProviderPanel();
const element = document.querySelector<ProviderPanelElement>(
  "agenticdriver-providers",
)!;
element.transport = (request) => applicationSettingsRpc(request);
await element.refresh();
```

`serveProviderPanel` from `@agenticdriver/sdk/panel-server` is the ready-to-run local application used by `agenticdriver panel`. See [the executable TypeScript example](../examples/javascript/provider-panel.mts). Its private profile persists through restarts. Disconnect forgets that profile; revocation is a separate host operation.

### Python

```python
from agenticdriver import ProviderPanel, provider_panel_html, provider_panel_script

panel = ProviderPanel(
    lambda: current_user_driver_client(),
    connection=lambda: {"id": connection.id, "label": connection.label, "url": connection.url},
    connect=save_connection_for_current_user,
    disconnect=forget_connection_for_current_user,
)
html = provider_panel_html(api_path="/api/settings/driver")
script = provider_panel_script()  # bytes; serve as text/javascript
# In the authorized application JSON route:
result = panel.handle(request_json)
```

`AsyncProviderPanel` accepts an `AsyncAgenticClient` getter and async connect/disconnect hooks; use `await panel.handle(request_json)`. Both bridges use the exact same packaged component. No Node runtime is needed in the consuming Python application.

### Go

```go
panel := agenticdriver.ProviderPanel{
    Client: func(ctx context.Context) (*agenticdriver.Client, error) {
        return currentUserDriverClient(ctx)
    },
    Connection: func() *agenticdriver.PanelConnection {
        return &agenticdriver.PanelConnection{ID: connection.ID, Label: connection.Label, URL: connection.URL}
    },
    Connect: saveConnectionForCurrentUser,
    Disconnect: forgetConnectionForCurrentUser,
}
markup, err := agenticdriver.ProviderPanelHTML("/api/settings/driver", "/assets/agenticdriver-panel.js")
// Serve agenticdriver.ProviderPanelScript as text/javascript.
// After application settings authorization and CSRF validation:
result, err := panel.Handle(request.Context(), limitedJSONBody)
```

`ProviderPanelScript` is embedded in the Go module; copying a separate JavaScript build is unnecessary. The bridge preserves empty deny-all model arrays through JSON serialization.

### Rust

```rust
use agenticdriver::{AgenticClient, Result};
use agenticdriver::panel::{PanelBackend, PanelConnection, handle_provider_panel,
    provider_panel_html, PROVIDER_PANEL_SCRIPT};

struct Settings<'a> { client: &'a AgenticClient }
impl PanelBackend for Settings<'_> {
    fn client(&self) -> Option<&AgenticClient> { Some(self.client) }
    fn connection(&self) -> Option<PanelConnection> {
        // Return your application's stable connection ID, label and public host URL.
        None
    }
}
// In the authorized application settings route:
fn route(settings: &mut Settings<'_>, request: &serde_json::Value) -> Result<serde_json::Value> {
    handle_provider_panel(settings, request)
}
// Serve PROVIDER_PANEL_SCRIPT as text/javascript and embed:
// provider_panel_html("/api/settings/driver", "/assets/agenticdriver-panel.js")?
```

Implement `can_connect` / `connect` and `can_disconnect` / `disconnect` on the backend to enable the setup controls. `AsyncPanelBackend`, `panel_snapshot_async` and `handle_provider_panel_async` provide the async equivalents. The browser module is included in the crate with `include_str!`; consumers do not need Node or a frontend build step.

## Connection hooks and identities

Each bridge's optional connect hook receives an `ad1.…` invitation. Parse it with the language client's invitation helper, use its short-lived code only to exchange for a connection credential, and put the resulting credential in the application's existing private secret store. Retain its stable ID, expiry and public URL. Use the new credential for the connected SDK client. Do not automatically retry an uncertain exchange: inspect/revoke its connection on the host first. TypeScript's `connectClient` and `connectedClient` additionally implement the private-file profile used by the standalone panel.

Resolve clients and descriptors for the same application user/request. A stable connection ID isolates device-local preferences; replacing a connection does not carry account preferences into a different identity. Native binary/account settings refer to paths on the connected host. Adding a new provider does not extend existing paired applications' provider grants.

## Logos and provider metadata

Reuse Usagestat's existing provider metadata/assets. The TypeScript bridge accepts a `presentations(providers)` callback returning `providerPresentation()` results keyed by SDK instance ID. Other bridges return a JSON snapshot that the application can enrich with the same `presentations` map. Serve reviewed assets from the application's own origin. The component renders those assets and uses provider initials when an asset is unavailable; it does not download remote images or build a competing provider-logo catalog.

## Validation

The shared panel is checked in the native T3 browser at desktop and narrow widths. Protocol tests exercise role restrictions, revisions, private profile reload, expired connections, browser origin checks, and credential non-disclosure. Installed language packages exercise the management bridge over real HTTP and certificate-verified HTTPS, preserving unrestricted and empty model lists. All CI runs use Prometheus. Browser inspection and catalog refresh do not spend inference tokens.
