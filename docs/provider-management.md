# Provider management

An execution host can expose provider settings to a separately authorized management
client. Applications keep their own authentication and authorize access to their
settings screen. This feature does not install an application identity system.

```ts
import { managedHost } from "@agenticdriver/sdk/management";
import { configuredServer } from "@agenticdriver/sdk/host";
import { serve } from "@agenticdriver/sdk/server";

const path = "/private/driver/config.json";
const host = await managedHost(path);
await serve(host.driver, {
  ...(await configuredServer(host.config(), path)),
  management: host.management,
});
```

`agenticdriver serve` also installs this controller. Give the operator credential
`manageProviders: true` in its host token configuration. Keep ordinary application
credentials separate. Management allows changing host executable paths, account
directories, API endpoints and credential references: grant it only to trusted
host operators. It does not imply permission to run models, invoke tools or read
application data. Ordinary provider discovery still respects the execution
credential's provider scope; operators can inspect every configured instance.

## Read and save

| Language              | Read settings            | Save a provider                         |
| --------------------- | ------------------------ | --------------------------------------- |
| TypeScript            | `client.management()`    | `client.configureProvider(change)`      |
| Python (sync/async)   | `client.management()`    | `client.configure_provider(change)`     |
| Go                    | `client.Management(ctx)` | `client.ConfigureProvider(ctx, change)` |
| Rust (blocking/async) | `client.management()`    | `client.configure_provider(&change)`    |

`GET /v1/management` returns `version: 1`, a content revision, provider
configurations and supported built-in kinds. `POST /v1/management/providers`
accepts `{ revision, provider, apiKey? }`. It adds the provider or replaces its
settings. Always send the latest revision; a stale save returns `CONFIG_CONFLICT`
without changing settings. An external file edit requires restarting the host
to load that change. Concurrent writers use an exclusive file lock. If a host
crashes during a save, its operator must reconcile the configuration before
removing a stale `.management-lock` file.

### Connection definitions

Newer hosts also return optional `providerDefinitions`, a pure setup catalog for
the integrations that the host supports. Reading it neither resolves provider
secrets nor starts native processes, login, model discovery or inference. It is
protected by the same `manageProviders` grant as settings. It does not claim that
the runtime is installed, the account is signed in, or a model has passed a test.

Each `ProviderDefinition` contains `kind`, `name`, `description`, `category`
(`native`, `api`, `compatible` or `fixture`), `protocol`, `methods`, and optional
`requirements`/HTTPS `docsUrl`. A `ProviderConnectionMethod` contains `id`,
`label`, `description`, `interaction` and `credentialOwner`:

| Interaction        | Current setup behavior                                                    | Credential owner |
| ------------------ | ------------------------------------------------------------------------- | ---------------- |
| `external`         | Use the official runtime's existing sign-in on the connected host         | `native-runtime` |
| `device-code`      | Owned Codex device sign-in, native verification and explicit confirmation | `native-runtime` |
| `api-key`          | Supply the write-only `apiKey` when saving a connection                   | `host`           |
| `secret-reference` | Set `apiKeyRef` to an existing host credential                            | `host`           |
| `none`             | Configure the offline fixture                                             | `none`           |

TypeScript exports both types from `@agenticdriver/sdk/client` and
`@agenticdriver/sdk/management`; Python, Go and Rust expose the same names.
Rust uses `provider_definitions`, while the wire, Python and TypeScript use
`providerDefinitions`; Go uses `ProviderDefinitions`. Absence means an older
host: retain its `supportedKinds` settings form. An empty list advertises no guided
setup choices. Check supported kinds and interactions before rendering actions.
Unknown future interaction strings are retained for display; the panel disables
them until it supports their flow. Render text as text and accept only safe HTTPS
documentation links.

Qualified hosts advertise the optional [owned provider sign-in lifecycle](provider-sign-in.md)
for Codex device authentication. Other native providers retain existing-session setup.
[The reference review](provider-connection-design.md)
explains the connection model and gateway/observability boundaries.

```ts
const state = await client.management();
await client.configureProvider({
  revision: state.revision,
  provider: { ...state.providers[0], name: "My subscription", enabled: true },
});
```

Keep the instance ID, kind and account ID stable. Use a new instance ID for a
different provider or account. Adding an instance does not expand existing
application credentials. Issue a connection grant with the desired provider IDs.
Extensions are installed and configured by the host operator; remote dynamic
module loading is not supported.

Omitting `models` allows every explicitly selected model. `models: []` denies
all model execution; an explicit list restricts this connection. `enabled: false`
disables new runs while retaining the saved model override. Model discovery and
client favorites never grant execution permission or certify a model.

API credentials use existing environment, private-file or keychain references.
The optional write-only `apiKey` field saves a replacement in a new private
0600 file. Responses contain only its reference. Previous credential files remain
available to in-flight runs; operators can remove retired files once those runs
finish. A native provider uses its official locally signed-in account directory.
No subscription-to-API billing fallback or automatic account switch occurs.

Settings are validated and saved atomically before activation. Running requests
retain their selected adapter and metering identity; refreshes never cancel them.
New executions use the saved configuration. Durable queued jobs retain the
existing account-identity checks. Runtime install/sign-in operations and arbitrary
launch-argument or environment-variable injection are not part of this contract.

The UI design follows the inspected T3 Code provider flow: host-owned instance
settings, independent metadata refresh, and client-owned model preferences. The
reference was the installed T3 nightly package (`f5ef0ddb90a8`); its code and
branding are not bundled in this SDK.
