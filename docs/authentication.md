# Application authentication and optional Better Auth integration

The [security review](security.md) describes token, tenant and execution trust
boundaries, tested defenses and remaining native-isolation qualification.

Applications own their authentication and choose their auth stack. Consuming the
SDK does not require Better Auth, AuthYard or a login migration. Application
identity, authorization to an execution host, and a provider account's native
sign-in are separate concerns; provider credentials stay on the execution host.

## Connect an existing authorization system

A programmatic host accepts the `HostAuthentication` interface exported from
`@agenticdriver/sdk/server`. Its `authenticate(token, signal)` checks the current
credential and returns an `AuthenticatedPrincipal`, or `undefined` to deny it.
The principal contains an opaque authorization `id`, a canonical `subject`, and
explicit provider, tool and other resource grants. Map those fields from the
application's trusted current policy, never from request metadata. Protect the
existing identity service's credentials and honor the supplied cancellation signal.

Supply this adapter as `serve(driver, { authentication, ...options })`, or through
the programmatic configured host. Use either `authentication` or static `tokens`,
never both. Static tokens have explicit host-owned grants but no built-in expiry
or rotation. Detached jobs additionally require `resolveJobPrincipal(id, signal)`
to recheck a durable, revocable grant after restart; never use a bearer as its ID.
See the [public contract](https://github.com/agenticdriver/agenticdriver/blob/sdk-roadmap/src/authorization.ts)
and [host configuration](host.md).

The [host connection flow](connections.md) and [desktop companion](desktop.md)
also support scoped host invitations and connection management without imposing
an application identity provider. Choose that flow or an application-owned
credential flow according to the integration. Browser cookies alone never
authorize SDK requests.

## Optional Better Auth and AuthYard recipe

The remainder of this guide describes the tested integration for applications
that select **Better Auth** with **AuthYard's `controlPlane` connector** for
management. Their existing Better Auth runtime and database remain authoritative
for identity, OAuth clients, consent and credentials. AgenticDriver authenticates
OAuth access tokens and maps their scopes to concrete driver resources. It does
not create another user, password, session or refresh-token database.

The tested integration pins Better Auth and `@better-auth/oauth-provider` to
**1.7.3**, with AuthYard's **`@authplane/better-auth` 0.2.0**, protocol 1, on
Node 24+. The connector comes from AuthYard's packed artifact, not npm. Read
[AuthYard's installation and protocol](https://github.com/hashimkarim/authyard/blob/0b9a3ccb9fa5993c91f02e0684d8d7caa8cdcc56/docs/connector-protocol.md)
and its supported version matrix before upgrading. AuthYard's hosted control
plane is `https://alpha.authyard.dev`; the local source is
`/mnt/shared/Git/authyard`. Follow its control-plane-first migration instructions
when adopting the forthcoming `@authyard/better-auth` package name.

The SDK's core still supports Node 22.13.0. Its `better-auth` and `pairing`
exports have no dependency on a bundled auth server. The application hosting
Better Auth and the AuthYard connector requires Node 24+ and persistent SQL.

## Configure the application auth runtime

Add these plugins to the application's existing `betterAuth` configuration.
Keep the application's database, login UI, identity IDs and authorization policy.
This is the OAuth device grant, not the first-party `/device/token` session flow.

```ts
import {
  oauthProvider,
  oauthDeviceAuthorization,
  DEVICE_CODE_GRANT_TYPE,
} from "@better-auth/oauth-provider";
import { controlPlane } from "@authplane/better-auth";

const plugins = [
  oauthProvider({
    // Opaque tokens use native introspection and immediate credential revocation.
    disableJwtPlugin: true,
    loginPage: "/sign-in",
    consentPage: "/consent",
    grantTypes: [
      "authorization_code", // required by this pinned version for refresh_token
      DEVICE_CODE_GRANT_TYPE,
      "refresh_token",
      "client_credentials",
    ],
    scopes: ["driver:personal", "driver:read-email", "offline_access"],
    accessTokenExpiresIn: 300,
    m2mAccessTokenExpiresIn: 300,
    resources: [
      {
        identifier: "https://driver.example",
        accessTokenTtl: 300,
        allowedScopes: [
          "driver:personal",
          "driver:read-email",
          "offline_access",
        ],
      },
    ],
    // Supply the application's actual owner/admin authorization callback.
    clientPrivileges: canManageOAuthClients,
    resourcePrivileges: canManageOAuthResources,
  }),
  oauthDeviceAuthorization({
    verificationUri: "https://app.example/connect/driver",
  }),
  // AuthYard must come after other plugins that install auth after-hooks.
  controlPlane({
    url: "https://alpha.authyard.dev",
    projectKey: process.env.AUTH_CONTROL_PLANE_PROJECT_KEY!,
  }),
];
```

Apply Better Auth's migrations, including the OAuth/device tables and AuthYard's
nonce, outbox and delivery tables. Set exact `trustedOrigins`, secure session
cookies and the application's ordinary signup/MFA policies. Configure production
rate limits for code issuance, verification, approval and OAuth token requests;
the device plugin's own path-specific limiter does not cover every route.

Provision a separate public native OAuth client per device, with
`token_endpoint_auth_method: "none"`, the device/refresh grants and its allowed
scopes. Keep anonymous dynamic registration disabled. Use Better Auth's supported
client/resource management to link each client explicitly to the resource above.
Provision a separate confidential resource-server client with that same resource
link for introspection. Keep `enforcePerClientResources` enabled and client/resource
caching disabled so native changes take effect on subsequent checks.

The application's `/connect/driver` page must require sign-in, accept the user
code, call `/api/auth/device?user_code=...`, display the registered device,
requested scopes and resource, then offer explicit approve and deny actions.
Send those decisions to `/api/auth/device/approve` or `/device/deny` using the
application session and its trusted origin. Merely following the verification
URL must not approve the device. Better Auth binds the reviewed code to that
signed-in user; a different user or unrelated origin cannot approve it.

## Authenticate the SDK host

```ts
import { serve } from "@agenticdriver/sdk/server";
import { betterAuthAuthentication } from "@agenticdriver/sdk/better-auth";
import { secretResolver } from "@agenticdriver/sdk/host";

const secrets = secretResolver("/etc/agenticdriver");
const authentication = betterAuthAuthentication({
  issuer: "https://app.example/api/auth",
  resource: "https://driver.example",
  clientId: resourceServerClientId,
  clientSecret: () => secrets({ file: "oauth-introspection-secret" }),
  scopes: {
    "driver:personal": { providers: ["personal-gemini"] },
    "driver:read-email": {
      providers: [],
      tools: ["read-thread"],
      retrieval: { search: ["selected-mailbox"] },
    },
  },
  resolveGrant: async ({ issuer, clientId, userId }, signal) => {
    // App-owned authorization: verify this exact issuer/client/user tuple.
    // Return undefined for unknown/revoked devices, users or service clients.
    const grant = await appGrants.lookup({ issuer, clientId, userId, signal });
    if (!grant?.enabled) return undefined;
    return {
      id: grant.id,
      subject: grant.canonicalSubject,
      scopes: grant.currentScopes,
    };
  },
});
const host = await serve(driver, {
  authentication,
  host: "127.0.0.1",
  allowedOrigins: ["https://app.example"],
});
```

For an in-process auth service, a Fetch-compatible wrapper can route the
introspection request to `auth.handler(new Request(input, init))`. Otherwise it
uses verified HTTPS; loopback HTTP is available for local development. Requests
never carry browser cookies or follow redirects. `requestTimeoutMs` bounds an
auth exchange, defaults to five seconds, and does not bound model execution.

`resolveGrant` returns authorization associated with existing app identities; it
is not a second identity store. Preserve its canonical subject across access-token
rotation. Map each provider ID to its already configured host/account binding.
Effective permissions are the intersection of the token's consented scopes, the
application's current grant and the host's explicit scope definitions. Unknown
scopes add nothing. Tool invocation, approval, application-tool execution, corpus
search/index/delete, sessions and jobs can be granted independently. Corpus grants
do not bypass the application's source/revision authorization.

Use either `authentication` or the existing static `tokens` configuration,
never both. Static tokens remain available for operator-owned service
installations; they do not gain rotation or expiry. Other applications can supply
their own `HostAuthentication` adapter as described above.

## Pair and rotate a device

```ts
import { BetterAuthPairingClient } from "@agenticdriver/sdk/pairing";
import { AgenticClient } from "@agenticdriver/sdk/client";

const pairing = new BetterAuthPairingClient({
  issuer: "https://app.example/api/auth",
  clientId: registeredDeviceClientId,
  resource: "https://driver.example",
  scopes: ["driver:personal", "offline_access"],
});
const request = await pairing.start(signal);
showPairingCode(request.userCode, request.verificationUri); // app UI
const credentials = await pairing.wait(request, signal);
await deviceSecretStore.replace(credentials); // app-owned atomic storage

const client = new AgenticClient({
  url: "https://driver.example",
  token: async (signal) => (await deviceSecretStore.read(signal)).accessToken,
});
```

Only show the user code and verification URL. Keep the device code, refresh
token and access token private. Polling honors the issuer's interval,
`authorization_pending`, `slow_down`, code expiry and explicit cancellation.
It never approves a device or launches a browser automatically.

Before expiry, call `pairing.refresh(refreshToken, signal)` and atomically replace
the stored credentials. Serialize refreshes across all processes using that
device; the helper rejects overlapping refreshes on one instance. It never retries
an uncertain rotation or an SDK operation after a 401. A lost response can require
pairing again. Better Auth rotates refresh tokens and rejects reuse; reuse can
invalidate the token family. `pairing.revoke(token, "access_token" | "refresh_token")`
uses native revocation. Revoke both retained credentials when disconnecting and
remove the application device grant when access for the device must end.

The browser-safe pairing helper stores nothing. Prefer the application's backend
or desktop main process for refresh credentials. Browser-only applications should
request only necessary scopes, keep short-lived access tokens in memory and omit
`offline_access` unless their architecture explicitly provides protected refresh
storage. Do not put credentials in URLs, logs, localStorage or IndexedDB.

Desktop apps can use the existing OS keychain secret references or inject their
platform secret-store implementation. Linux uses Secret Service and macOS uses
Keychain; Windows applications supply their own credential manager or a protected
service secret. Headless services use secret-manager injection or private files.
See [secret storage and platform limits](host.md#secret-references-and-diagnostics). The SDK does
not copy a provider CLI's sign-in, and provider credentials remain on its host.

Python, Go and Rust clients use the same OAuth bearer credential with no protocol
change. Their application auth component can perform this standard device flow,
store/refresh credentials, and construct clients with the current access token.
The TypeScript token resolver is an additional convenience, not another wire
authentication mechanism.

## Services, jobs and revocation boundaries

Backend services use a separately registered confidential Better Auth OAuth
client and `client_credentials`. Configure `client_credentials_scopes` explicitly
through Better Auth's authorized administrative API. An opaque service token has
no user subject: map its exact client ID to an explicit service subject. Never
substitute the client owner's user identity. This preserves tenant and Usagestat
accounting boundaries.

Authentication and expiry are checked on every HTTP request and again before a
queued foreground run enters execution. Expiry and revocation reject new work;
an already admitted foreground run keeps its accepted authorization until it
finishes or is explicitly cancelled. Credential lifetime does not introduce a
hidden total run deadline. Use application cancellation when disconnecting a
device must interrupt its in-flight foreground work.

Detached jobs require an explicit `resolveJobPrincipal(id, signal)` in addition
to authentication. Persist a stable, revocable authorization reference in the
application, with a scope ceiling no broader than the accepted device grant.
Never use or persist a bearer/refresh token as that reference. The resolver must
check current device/client/user status and return the same ID and canonical
subject, plus current resource permissions, after host restart. Enabling jobs
without this resolver fails at startup. Job API access also intersects the
request credential's scopes, so a narrowly scoped fresh token cannot inherit a
broader durable grant. Queued and running jobs recheck the durable grant;
revocation interrupts active jobs on the worker's next policy check.

AuthYard manages the existing application identity/session runtime. Ordinary
sign-in and OAuth introspection do not depend on AuthYard being reachable.
Management verification fails closed during an outage, and its connector queues
events for retry. OAuth device grants and app resource permissions remain under
Better Auth and application policy; do not claim the AuthYard console exposes an
OAuth-device management feature it has not implemented.

## Verification

Applications qualify their own existing authentication runtime, connector and SDK
host using actual scoped credentials. The previous simulated-provider integration
suite is removed. Historical connector provenance remains in
[integrations/better-auth/vendor/README.md](../integrations/better-auth/vendor/README.md).
No application auth migration or identity system is required merely to use the SDK.
