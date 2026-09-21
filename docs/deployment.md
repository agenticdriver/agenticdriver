# Self-hosted HTTPS deployment

The [Compose recipe](../deploy/compose.yaml) runs an API-provider execution host
behind Caddy. Only the proxy's TLS port is published. The host binds to
`127.0.0.1:7433` inside the proxy's network namespace, so another container cannot
bypass TLS by using the host's container address. Both processes run as UID/GID
1000 with a read-only root filesystem, no Linux capabilities and no privilege
escalation. Writable state has a separate named volume.

Authentication uses the application's **Better Auth** OAuth provider paired with
**AuthYard**, as described in [the authentication guide](authentication.md).
The stock entry point accepts explicitly registered backend service identities.
Each service maps to one canonical application subject and a bounded set of SDK
scopes. It rejects user tokens. For direct end-user device pairing, build an
application host with `betterAuthAuthentication` and the application's current
user/device grants. Keep application users, organizations, credentials and
sessions in its existing Better Auth database.

The image contains configured API adapters and the mock adapter. It contains no
signed-in CLI account, arbitrary extension loader, auth server or management
credential. Native agent isolation/certification and detached-job authority need
a separately configured application host; the stock entry point rejects those
configurations. Application tools, approvals and foreground sessions can be
enabled explicitly through the regular host configuration and scope grants.

## Prepare a host

Use a Linux Docker Engine with Compose v2.20+ (or v5), a selected DNS name, a
trusted certificate with that name in its SANs, and an application Better Auth
service reachable by HTTPS. No registry image has been published yet: build the
two images from a reviewed SDK commit. The Node 24 and Caddy 2.11.4 bases are
pinned to multi-platform manifest digests in their Dockerfiles. The deployment
test currently verifies Linux amd64. Other architectures remain unqualified.

```bash
# In the reviewed SDK checkout. These commands build locally; they publish nothing.
docker compose -f deploy/compose.yaml build
install -d -m 700 deploy/runtime/{config,secrets,tls}
install -m 600 deploy/config.example.json deploy/runtime/config/config.json
install -m 600 deploy/authorization.example.json deploy/runtime/config/authorization.json
```

Provision `runtime/tls/server.crt` (the leaf and intermediates) and
`runtime/tls/server.key` with mode 0600. Arrange renewal using the operator's
existing certificate automation. The mounted directory, rather than individual
files, permits atomic replacement. Caddy's admin endpoint and automatic
certificate issuance are disabled in this recipe. For a private CA, install only
its certificate in the clients' trust configuration; never disable certificate
or hostname validation.

Give UID/GID 1000 read access to these private runtime directories/files. On a
server where the deploying user has another UID, have an administrator set that
ownership explicitly. Do not make credentials world-readable to solve a mount
permission problem. A Docker user namespace or rootless installation must map
the container UID accordingly; the automated gate uses rootful Docker with
non-root containers. On SELinux systems, pre-label the dedicated bind directories
for shared container access according to local policy. Do not disable SELinux or
relabel unrelated application directories.

Both Docker build contexts deny files by default. Runtime secrets, private TLS
keys, local accounts and the test auth fixture are excluded from production
image layers. Supply secrets as mounted files, not Docker build arguments,
committed JSON values or command-line bearer arguments.

## Provision service authorization

Follow the tested Better Auth/AuthYard versions and migration order in the
[auth guide](authentication.md). The application should have:

1. A resource identifier such as `https://driver.example`, with explicit
   allowed OAuth scopes and a chosen access-token lifetime.
2. A confidential resource-server client authorized to introspect that resource.
   Write its secret to `runtime/secrets/oauth-introspection-secret` with mode 0600. This credential stays on the driver host.
3. A distinct confidential client for each application backend, with the native
   `client_credentials` grant, explicit `client_credentials_scopes`, and a link
   to this resource. That backend keeps its own client secret and obtains native
   short-lived OAuth access tokens. It sends only the access token to the SDK.

Set `authorization.json` to the exact Better Auth issuer (including `/api/auth`),
resource, introspection client ID and secret reference. Map each SDK OAuth scope
to its permitted provider IDs, tool names and optional session/retrieval grants.
Map the backend client ID to its canonical service subject. These are explicit
application policy decisions, not IDs supplied by an SDK request.

The scope definitions loaded at startup are the maximum permissions. The host
rereads `services` for every authenticated request, so removing a service or its
scope stops subsequent access. Replace this JSON file atomically to avoid a
partially written policy. Changing issuer/resource/client ID fails closed until
a restart; changing scope definitions also requires a restart. Secret contents
are read for each introspection request, so rotation at the same secret path
does not require a restart. Native Better Auth expiry/revocation remains
authoritative. Authentication and authorization failures never trigger an
automatic identity or provider fallback.

Foreground runs retain the authority accepted at admission until completion or
cancellation. Revocation rejects later requests; it does not retroactively undo
an already running action. Operators can stop the host to cancel all of its
foreground runs. More immediate per-run revocation requires application-owned
tracking and cancellation, as explained in the auth guide.

`config.json` uses the [regular host schema](host.md). Leave `tokens` absent;
the deployment requires Better Auth and rejects static driver tokens. The example
selects a synthetic mock provider. To run a real API account, change the provider
kind, instance ID and explicit model list, set a private `apiKeyRef`, update the
scope's provider ID, and retain stable `usage.hostId` and `accountId` values.
No live provider selection is inferred from secrets present on the machine.
Configure the existing [Usagestat sink](usagestat.md) if desired; this recipe does
not introduce another usage service.

For a private-CA Better Auth service, mount its CA certificate read-only and set
`NODE_EXTRA_CA_CERTS` on the driver container. It is separate from the public
proxy certificate and must validate the configured issuer hostname.

## Start and connect

The default published port binds to the server's loopback address. After
selecting the intended host interface and firewall access, start the service:

```bash
AGENTICDRIVER_BIND_ADDRESS=YOUR_SERVER_ADDRESS \
  docker compose -f deploy/compose.yaml up -d --wait --no-build
```

The TLS port defaults to 8443; set `AGENTICDRIVER_HTTPS_PORT=443` if that is the
selected external port. Clients use `https://YOUR_CERTIFICATE_HOSTNAME:8443` and
their backend's native OAuth access token. TypeScript/JavaScript, Python, Go and
Rust all connect to the same endpoint. See their [client guides](../README.md#other-languages)
and the authentication guide for credential refresh. The SDK never disables TLS
verification or silently refreshes/retries a potentially completed action.

`GET /health` returns process readiness without a bearer and without account
details. The container health check exercises this internal endpoint; separately
monitor `https://YOUR_CERTIFICATE_HOSTNAME:8443/health` with certificate validation
to detect proxy, DNS and renewal failures. It does not claim provider readiness.
An authenticated catalog refresh checks the selected account separately.

By default, browser origins are denied. Add exact `allowedOrigins` only for
applications that should make browser requests. The proxy removes cookies from
upstream requests; SDK authorization always uses the bearer header. It preserves
protocol/version and cache-control headers and adds HSTS and `nosniff`.
Access logging is disabled. Runtime failures use redacted messages, so inspect
configuration validity, file ownership and the app auth service when readiness
fails. Never turn on body or authorization-header logging for diagnosis.

## Streaming, capacity and shutdown

There is **no default total run deadline or inactivity timeout**. The proxy has
no configured stream timeout or response-header timeout and no retries. SSE
responses flush as data arrives. Do not add `flush_interval -1`: Caddy documents
that a negative interval keeps the upstream request running after a downstream
disconnect. The default SSE behavior permits cancellation to reach the model.
See [Caddy's streaming semantics](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).

`concurrency.total` and `concurrency.perSubject` bound active work. With the
example's queue omitted, excess requests return `429` with `BUSY` before model
work starts. Select capacities appropriate to the host and provider account.
Do not automatically retry uncertain operations. Durable operation records allow
the same idempotency key to replay a finished result after a restart without a
second model call.

Infrastructure limits are separate from run policy:

| Boundary               | Recipe behavior                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming headers/body  | Node requires headers within 10 seconds and the request body within 30 seconds; Caddy caps bodies at 2 MB. These do not bound response generation.                |
| Auth introspection     | 5-second fail-closed deadline per authentication check, before run admission.                                                                                     |
| Model/tool progress    | No timer unless the application or host sets `idleTimeoutMs`; network heartbeats do not count as progress.                                                        |
| Health probe           | 5-second probe timeout and readiness/retry settings; it does not cancel accepted model work.                                                                      |
| Operator shutdown      | SIGTERM cancels foreground work and flushes terminal records; Compose allows 30 seconds before force termination.                                                 |
| Outside infrastructure | Provider account limits, load balancers, VPNs, firewalls and container resource exhaustion can still interrupt connections; qualify the selected production path. |

Use `docker compose -f deploy/compose.yaml stop driver` for a controlled drain by
cancellation. Stop the driver before replacing its proxy network namespace.
For certificate replacement or a proxy image/container replacement, recreate both
services together so the driver joins the new namespace and Caddy reads the new
certificate. This interrupts streams:

```bash
docker compose -f deploy/compose.yaml stop driver
docker compose -f deploy/compose.yaml up -d --wait --no-build --force-recreate proxy driver
```

Accepted runs are not migrated between replicas. This recipe is a single host,
with local capacity and state. Do not share its operation directory between
independent writers or put an uncoordinated load balancer in front of replicas.

## Back up, upgrade and roll back

Keep the selected SDK commit, local image IDs, configuration and proxy image ID
in the deployment record. Build and test new images before switching services.
`AGENTICDRIVER_IMAGE` and `AGENTICDRIVER_PROXY_IMAGE` select operator-owned tags
or digests; they are not registry publication instructions.

Stop the driver before taking a consistent backup of `driver-state`; it contains
operation outcomes and usage records, potentially including application content.
Encrypt backups and restrict their access. Back up config separately from secret
references, and use the existing secret manager's recovery process for secrets.
The application's Better Auth database and AuthYard connector state have their
own application-owned backup and migration lifecycle.

To roll back, stop the driver, restore a compatible state backup if the upgrade
changed storage, select the previous reviewed image/configuration pair, and
restart both services. Verify external TLS health and a deliberately selected
mock or provider workflow. `docker compose down` preserves the named state
volume; `down --volumes` deletes it and is reserved for disposable test data.

## Reproduce the deployment gate

```bash
npm ci
npm run test:deployment
```

This requires Linux Docker/Compose, OpenSSL 3, Python, Go and the Rust toolchain
from the compatibility matrix. The gate builds fresh local production/proxy
images plus a **test-only** Better Auth/AuthYard application. It creates a private
CA and native service credentials, starts an isolated Compose project, and uses
installed npm/wheel/Go-module/crate artifacts from all four languages through
verified HTTPS. It checks streaming before completion, disconnect cancellation,
headers, admission limits, graceful SIGTERM, durable replay, policy revocation
and absence of fixture credentials in logs. All model responses are synthetic.
Cleanup removes only that disposable project's containers/network/volume.

This gate establishes container and protocol behavior. A chosen public server,
DNS/certificate renewal route, live AuthYard project and provider account need
their own deployment qualification; none is provisioned by this test.
