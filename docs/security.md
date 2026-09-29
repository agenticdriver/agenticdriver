# Execution and authentication trust boundaries

This is the integrated Linux RC review for [AD-041 / #35](https://github.com/agenticdriver/agenticdriver/issues/35).
It records authority boundaries, current real-account evidence and residual
assumptions. The selected Codex/Claude routes have actual execution, account
separation and recovery evidence; final immutable RC and application acceptance
remain [release gates](release-candidate.md). This is not an independent audit,
proof for arbitrary plugins, or qualification of every provider/platform.

## Authority and ownership

The application owns canonical users, services, documents, mailbox access,
approvals and accepted artifacts. Its chosen identity system remains
authoritative; SDK consumption does not require an auth migration. A programmatic
host's `HostAuthentication` adapter validates current credentials and maps trusted
application policy to a canonical subject and explicit resource grants.

When the optional Better Auth integration is selected, Better Auth issues/revokes
credentials and the AuthYard connector supplies management and event delivery.
SDK introspection intersects token consent, current application grants and concrete
host scopes. Client metadata, retrieved text and model output confer no authority.

The execution host's operator is trusted with provider credentials, configured
endpoints, adapters, tool code, native binaries, resolvers and state storage.
An extension is executable host code, not a sandboxed package. A compromised host
account or plugin can access its process's secrets; API scopes do not isolate
mutually untrusted OS users or native agents. Use separately qualified OS/container
boundaries for those cases. The API deployment uses explicitly configured service clients; the separate
[Linux account-container recipe](account-isolation.md) provides dedicated native
account volumes and process namespaces.

| Boundary                             | Current enforcement and evidence                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser/client → host                | Exact origin allowlist, bearer required, strict UTF-8/body bounds and version negotiation. Actual HTTP checks: [security receipt](validation/security-real-2026-09-29.md).                                                        |
| Transport → credentials              | HTTPS or explicit loopback through verified SSH, no credential-bearing base URLs or redirects. Four-client source review and actual [account HTTPS routes](validation/account-isolation-2026-09-29.md).                           |
| Request → execution/management       | Independent grants; metadata cannot add authority. Actual negative requests and one-use pairing/revocation: [security receipt](validation/security-real-2026-09-29.md).                                                           |
| Approval/ticket → effect             | Subject/provider/run/tool/argument binding, separate scopes and single-use decisions/results. Real native tool proposals and application reads: [security receipt](validation/security-real-2026-09-29.md).                       |
| Tenant/document → retrieval          | App-owned namespace and source revisions, permission rechecks, exact citation IDs. Actual embeddings, PDF/Markdown/email, stale/deleted evidence and four clients: [retrieval receipt](validation/local-retrieval-2026-09-29.md). |
| Restart/replay → effects             | Stored outcomes never issue another executable ticket. Real completed, denied and uncertain cancelled operations preserve their ledgers across restart: [security receipt](validation/security-real-2026-09-29.md).               |
| Native account → other accounts/host | Dedicated Linux containers, private account volumes and process namespaces, read-only runtime, non-root, dropped capabilities, cancellation/shutdown checks: [account receipt](validation/account-isolation-2026-09-29.md).       |
| Runtime → logs                       | Public failures are bounded/redacted; the four current SDK bearers were absent from inspected journal/usage/approval logs. Arbitrary extension/native logging remains operator-owned.                                             |

Optional Better Auth/device integration tests and former simulated-provider suites
are historical evidence. They are not substitutes for the current records above
and do not impose that identity system on consumers. Changing an auth connector,
platform, model or native runtime requires qualification of that selected route.

## Bearers, pairing and revocation

A stolen valid bearer has the holder's currently authorized privileges. CORS
does not stop a non-browser client from using it. TLS protects transport, while
the application must protect token storage and its pairing/consent UI. The SDK
neither persists browser credentials nor extracts provider-native sign-in tokens.
Keep app and host logs free of authorization headers and refresh/device codes.

The optional OAuth device-pairing helper keeps verification URLs on the issuer's
origin. Its auth HTTP calls omit
cookies, reject redirects, bound response sizes and have an explicit short auth
exchange timeout. The refresh helper rejects concurrent refresh attempts and
does not retry an uncertain rotation. The earlier optional Better Auth qualification checked a denied
foreign origin/user/client, consumed device-code replay, scope intersections,
revocation, reuse invalidation and service identities distinct from their owners.
The separate [host invitation flow](connections.md) uses host-owned scoped grants
and one-use invitations; it does not create application identities or impose an
OAuth issuer. Other auth adapters must preserve their chosen issuer's credential
and revocation semantics.

Foreground work keeps the authority accepted when execution starts; queued work
rechecks authorization before starting. Revoking a credential blocks later
requests, not every effect already accepted inside an active run. Disconnect or
cancel to stop foreground work. Tools must still recheck the application's
current resource revision and approval immediately before a side effect.

Detached jobs require a separately implemented durable current-grant resolver;
request tokens cannot become indefinite worker credentials. The SDK narrows
durable authority to admitted scopes, rechecks it and interrupts revoked jobs.
The application resolver must bound its own network/database calls and observe
cancellation. In the optional integration, AuthYard management outages do not replace or bypass Better Auth's
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

The earlier AD-041-001 malformed UTF-8 defect was fixed with fatal decoding.
The current actual-host check again returned `INVALID_REQUEST` before inference.
No new release-blocking SDK defect was found in the exercised Linux scope.
The security qualification corrected two harness assumptions, retained their
failed receipts and recovered the original operations without repeating inference.

A real email assessment also exercised hostile embedded instructions. The selected
model identified the attack and produced only a cited assessment. This single
observed response is not a general prompt-injection defense. Retrieved text, source
metadata and model output cannot grant access; applications must still authorize
resources and review requested effects independently of model behavior.

The current [package and pure contract checks](conformance.md) contain no model
substitutes. They check schema, parser, process and installation contracts separately
from the live records above. Windows/macOS isolation, unselected providers/models,
optional auth deployments and a hostile host/kernel remain outside this review.
Protect the operator account, configuration, trusted parent directories and state
backups; an attacker who can replace those files is already inside the host trust
boundary. Connection revocation cannot undo previously accepted external effects.
