# Execution and authentication trust boundaries

This is the AD-041 review of the current SDK, Better Auth/AuthYard integration
and self-hosted API deployment. It records implemented controls, tests and
remaining assumptions. **AD-041 remains open pending AD-012's native process
isolation qualification.** Passing local tests is not an independent audit,
live-provider certification or proof of an unselected production deployment.

## Authority and ownership

The application owns canonical users, services, documents, mailbox access,
approvals and accepted artifacts. Better Auth issues/revokes its credentials;
the existing AuthYard connector supplies management and event delivery. SDK
introspection intersects token consent, current application grants and concrete
host scopes. Client metadata, retrieved text and model output confer no authority.

The execution host's operator is trusted with provider credentials, configured
endpoints, adapters, tool code, native binaries, resolvers and state storage.
An extension is executable host code, not a sandboxed package. A compromised host
account or plugin can access its process's secrets; API scopes do not isolate
mutually untrusted OS users or native agents. Use separately qualified OS/container
boundaries for those cases. The stock Linux deployment currently permits only
configured API/mock providers and explicit service clients.

| Boundary             | Enforcement                                                                                                                                | Evidence                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Browser → host       | Exact origin allowlist; bearer still required; cookies do not authorize SDK work                                                           | `server.test.ts`, `security-boundaries.test.ts`                                  |
| Client → host        | Verified TLS for remote listening; no credential-bearing base URLs or redirects                                                            | Four-client conformance, `network-faults.test.ts`, `security-boundaries.test.ts` |
| Host → Better Auth   | Opaque active bearer; exact issuer/resource/client-user binding; expiry and current grants; bounded, uncached introspection                | `better-auth.test.ts`, real-package auth contract                                |
| Device → application | Native device consent, same-user review and client binding; one-time device-code exchange; refresh rotation/reuse and revocation           | `integrations/better-auth/auth.test.mjs`                                         |
| Request → execution  | Provider/model/tool scopes, admission revalidation and account identity configured on the host                                             | `scheduling.test.ts`, `better-auth.test.ts`, `security-boundaries.test.ts`       |
| Approval → effect    | Subject/provider/run/tool/argument binding; separate approver/executor authority; no repeated accepted effect                              | `approvals.test.ts`, `application-tools.test.ts`                                 |
| Tenant → state       | Sessions, operations, jobs and corpus access bind to current identity; replay reauthorizes evidence                                        | `sessions.test.ts`, `idempotency.test.ts`, `jobs.test.ts`, `retrieval.test.ts`   |
| Document → model     | Explicit source revisions and authorized resolver leases; instructions remain untrusted data; no implicit tools or URL/file reads          | `context.test.ts`, `ingestion.test.ts`, `security-boundaries.test.ts`            |
| Runtime → telemetry  | Stable host/account identity, bounded diagnostic fields, explicit host labels; provider bodies and untyped exceptions are redacted         | `usage.test.ts`, `diagnostics.test.ts`, `provider-extensions.test.ts`            |
| Host → proxy/network | Raw host on namespace-local loopback; non-root/read-only containers, dropped capabilities, certificate checks and cancellation propagation | `scripts/test-deployment.py`                                                     |

Test paths above live in [`tests/`](../tests/), except the explicitly named
integration/deployment scripts. The native auth contract uses Better Auth and
OAuth Provider 1.7.3, with the qualified AuthYard `@authplane/better-auth` 0.2.0
artifact. Renamed or changed connector versions require their own qualification.

## Bearers, pairing and revocation

A stolen valid bearer has the holder's currently authorized privileges. CORS
does not stop a non-browser client from using it. TLS protects transport, while
the application must protect token storage and its pairing/consent UI. The SDK
neither persists browser credentials nor extracts provider-native sign-in tokens.
Keep app and host logs free of authorization headers and refresh/device codes.

Pairing verification URLs must stay on the issuer's origin. Auth HTTP calls omit
cookies, reject redirects, bound response sizes and have an explicit short auth
exchange timeout. The refresh helper rejects concurrent refresh attempts and
does not retry an uncertain rotation. Real Better Auth tests verify a denied
foreign origin/user/client, consumed device-code replay, scope intersections,
revocation, reuse invalidation and service identities distinct from their owners.

Foreground work keeps the authority accepted when execution starts; queued work
rechecks authorization before starting. Revoking a credential blocks later
requests, not every effect already accepted inside an active run. Disconnect or
cancel to stop foreground work. Tools must still recheck the application's
current resource revision and approval immediately before a side effect.

Detached jobs require a separately implemented durable current-grant resolver;
request tokens cannot become indefinite worker credentials. The SDK narrows
durable authority to admitted scopes, rechecks it and interrupts revoked jobs.
The application resolver must bound its own network/database calls and observe
cancellation. AuthYard management outages do not replace or bypass Better Auth's
local authority; the qualified connector queues management events independently.

## Endpoints, context and local files

Only trusted host configuration supplies provider/vector/auth URLs, native
executables and secret references. HTTPS and explicit loopback HTTP are supported;
redirects and URL credentials/query/fragment are rejected for credential-bearing
base URLs. Host-owned private endpoints are intentional, so this is not a global
ban on internal addresses or a DNS-rebinding sandbox. Operators control their
DNS, proxy, egress and network reachability. Custom fetch implementations and
extensions must preserve the documented redirect/TLS behavior.

Attachment/source URIs are display metadata; the SDK never fetches them. Context
references resolve through an app-owned authorizer with exact source revisions,
bounded bytes, lease cleanup and access rechecks. Source IDs cannot contain path
separators. Ingestion accepts supplied bytes/text or authorized references, never
a model-supplied command or filesystem path. Vector indexes remain derived data;
apps enforce canonical corpus/source ownership and validate citation IDs against
actual returned evidence. Applications must also validate display URLs before
opening them or using them in their own fetch/preview integrations.

Secret file paths may be absolute or relative because the host operator owns
their configuration; they are not a request-facing file API. The opened file must
be regular, bounded and private on POSIX. Symlinks can intentionally resolve to
operator-managed mounted secrets. Windows ACL/credential-store behavior is part
of pending native/platform qualification. The deployment's Docker build contexts
exclude runtime secrets. Protect persisted SQLite state and backups: private
file permissions do not provide encryption at rest.

## Findings and test scope

AD-041-001: the HTTP request reader previously used replacement decoding for
invalid UTF-8. An authenticated malformed JSON byte string could return 200 and
reach the model as altered text. It now uses fatal UTF-8 decoding and returns
`INVALID_REQUEST` before inference. The regression reproduced the earlier 200
and now asserts 400 with zero provider invocations. This was a request-integrity
defect; the test did not establish an authorization bypass.

The new combined checks also use real HTTP redirect peers to prove that client
bearers, resource-server introspection credentials and device refresh tokens do
not reach the redirect target. A Better Auth-authenticated host denies forged
tenant metadata and another user's reference, never fetches a source metadata
URL, rejects an unselected tool emitted after hostile document content, and
records the configured canonical usage identity. Existing tests cover argument
substitution, replay, revoked evidence and credential/error leakage.

Run the review checks from the SDK checkout:

```sh
npm ci
npm run check
npm run test:auth
npm run test:clients
npm run test:deployment
```

The auth and container checks require Node 24+; container testing also requires
Docker Compose and the four language toolchains. See [compatibility](compatibility.md).
Fixture deadlines protect test infrastructure. Header/body ingress limits,
authentication exchange timeouts and operator shutdown grace do not add a default
SDK run deadline or inactivity timeout. An operator still needs appropriate
connection/auth rate controls for its actual public ingress and auth service.

Remaining release gates: native account/process isolation under AD-012 and the
provider-specific certifications; the selected Antigravity native tool-isolation
blocker; Grok Build's idle/side-work controls; actual app/registry/production
deployment qualification; and a fresh hosted CI run after GitHub's account
billing/spending restriction is resolved. Locally passing fixtures do not close
these gates or authorize automatic fallback to another model/account.
