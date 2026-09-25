# Connect a local or remote host

Start a new host on the machine containing the selected provider login:

```sh
agenticdriver setup --provider codex --config ./driver/config.json --manage
```

This creates private application and operator credential files, starts the host,
and prints an invitation valid for ten minutes. `--manage` gives the resulting
connection permission to configure providers and issue/revoke connection grants.
Omit it for ordinary application execution access. Choose `--provider mock` for a
fully offline setup. Each model run still needs an explicit provider and model.

Paste the `ad1.…` invitation into the application's connection panel. The
application backend exchanges it once and saves the resulting credential privately.
An invitation cannot be replayed, reused by a second app, or used after expiration.
The default connection lifetime is thirty days; operators can choose a shorter
lifetime or revoke it immediately. Existing static credentials remain unchanged.

For a command-line client, save the invitation in a private text file and run:

```sh
agenticdriver connect --invite-file ./invitation.txt --connection ./app/driver.json
```

The command reports only the host URL, connection ID, expiration and private file
paths. It creates a fresh profile rather than overwriting an existing connection.
Use `connectedClient(profilePath)` from `@agenticdriver/sdk/connections` in a Node
backend. Other languages can consume the same private JSON profile and its sibling
token file, or store exchanged credentials in their existing secret store.

To resume the host later or connect another application:

```sh
agenticdriver serve --config ./driver/config.json
agenticdriver pair --config ./driver/config.json --subject another-app
```

`pair --provider-ids local-codex,company-api` restricts the invitation to those
configured instances. Existing application credentials are never expanded when
providers are added. Use `--manage` only when that application should administer
the host. The operator token used by `pair` defaults to the `operator` token
created by `setup`; `init --management` can create the same separate operator grant.

## Remote hosts

Run the setup command on the provider machine with its own certificate/key and
an HTTPS URL reachable by the connecting backend:

```sh
agenticdriver setup --config ./driver/config.json --provider codex --manage \
  --host 0.0.0.0 --port 7433 --client-url https://driver.example:7433 \
  --tls-cert-file /private/fullchain.pem --tls-key-file /private/key.pem
```

Use the same invitation flow. TLS verification remains enabled; configure your
client's CA trust for private certificates. A loopback URL refers to the machine
running the application backend. For an app hosted elsewhere, use a reachable
TLS host or an explicitly configured SSH tunnel terminating beside that backend.
The SDK does not install a tunnel, change a firewall, or discover remote machines.

## All-language connection API

| Operation         | TypeScript                | Python sync/async          | Go                                | Rust blocking/async                    |
| ----------------- | ------------------------- | -------------------------- | --------------------------------- | -------------------------------------- |
| Parse invitation  | `connectionTarget(text)`  | `connection_target(text)`  | `ParseConnectionInvitation(text)` | `connections::connection_target(text)` |
| Create invitation | `createInvitation(input)` | `create_invitation(input)` | `CreateInvitation(ctx, input)`    | `create_invitation(&input)`            |
| Exchange          | `exchangeConnection()`    | `exchange_connection()`    | `ExchangeConnection(ctx)`         | `exchange_connection()`                |
| List grants       | `connections()`           | `connections()`            | `Connections(ctx)`                | `connections()`                        |
| Revoke by ID      | `revokeConnection(id)`    | `revoke_connection(id)`    | `RevokeConnection(ctx, id)`       | `revoke_connection(id)`                |

Construct an exchange client with the parsed URL and one-use code as its token.
Construct the resulting execution client with the returned `token`. `grant`
contains the explicit subject, provider allowlist and optional management/tool/
job/session/retrieval permissions. A provider/model selection or application UI
preference never broadens these grants. Provider API keys and subscription login
files remain on the execution host.

Programmatic hosts compose `hostConnections(path, { providers })` and
`withConnections(serverOptions, store)`. `managedHost()` creates the store beside
its configuration; pass `host.connections` to `withConnections`. `serve` alone
retains its original authentication contract. Applications keep their existing
auth stack and authorize who may access settings or create a backend connection.

Invitations and tokens are secrets. Keep invitation strings out of query strings,
logs, source control and browser persistence. Grant lists contain no codes,
tokens or hashes. The host stores only credential hashes in a private file and
checks expiration/revocation on each request and durable-job authorization.
Revocation prevents new access; it does not cancel already running requests.

If an exchange loses its response, do not automatically repeat it. Use the
operator's connection list to revoke the uncertain new grant, then issue a fresh
invitation. File writes use exclusive locks and atomic replacement. After a host
crash during a write, reconcile state before removing its stale `.lock` file.
