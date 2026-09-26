# Provider sign-in validation — 2026-09-26

Scope: the source-preview Codex device authentication method and its owned SDK
lifecycle, plus desktop `0.1.0-alpha.2`. This is not a registry SDK release or a
live-account/model qualification. [The contract](../provider-sign-in.md) describes
the supported workflow and its limits.

## Actual native runtime

`scripts/test-codex-native.py --suite setup` ran the official Linux x64 Codex
`0.157.0` ELF and adjacent code-mode executable in a bubblewrap namespace. The
real home was hidden and external networking disabled. Binary SHA256:
`1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258`.

The production SDK worker, manager and HTTP transport drove native initialization,
empty-account verification, `account/login/start` with `chatgptDeviceCode`, native
completion and a fresh verified `account/read`. The fixture proved:

- Actual native device-code polling, token exchange, workspace account routing
  and private credential-file creation. The SDK did not read credential contents.
- Caller-bound attempt access, inability to confirm before native verification,
  explicit confirmation, stable SDK account binding and unchanged execution grants.
- Cancellation and graceful-shutdown cleanup of unpublished private profiles;
  a confirmed profile and unrelated existing-account sentinel remained intact.
- No thread/turn/tool/model RPCs and zero model calls.

The fixture's synthetic issuer uses Codex's official test issuer override on a
loopback HTTP server. A test-only executable interposer passes the actual native
RPC stream through and translates **only** that fixture verification URL to the
production allowlisted device URL. Login IDs, completion, account verification,
token exchange and storage are the native implementation. This seam does not
qualify live issuer TLS, browser authorization, account device-flow eligibility,
quota or any model. Production strips that test override and rejects a device
URL other than `https://auth.openai.com/codex/device`.

The only provider HTTP routes observed were synthetic `/api/accounts/deviceauth/usercode`,
`/api/accounts/deviceauth/token`, `/oauth/token` and `/backend-api/wham/accounts/check`.
Raw exchange bodies, headers and credential files were not included in receipts.

## Lifecycle and wire checks

The SDK check passed 336 tests, including new worker/lifecycle cases for early
completion notification ordering, wrong login ID, unsafe device URL, completion
without a verified account, populated-profile preservation, process cancellation,
opaque/caller-bound attempts, revision conflict, credential expiry, replay rejection,
shutdown, configuration preflight and redacted synchronous native failures.
Existing active-run configuration isolation tests continued to pass.

The TypeScript, Python sync/async, Go and Rust blocking/async clients passed the
shared conformance cases over loopback HTTP and certificate-verified HTTPS.
New cases exercise waiting and verified state, empty lists, malformed/duplicate
attempts, wrong account/provider/revision/attempt ID, invalid phase/time/ID and an
untrusted device URL. The reference host checks the exact serialized setup request.
Native account credentials are absent from the wire contract.

## Desktop and browser checks

Seven desktop backend/security/packaging tests passed. Native Electron launch
passed on Fedora with the actual renderer, isolated IPC and bundled Node. The
external-link policy allows the exact official device page and rejects other
issuer paths, query/hash injection and lookalike hosts.

The native renderer regression also checks the actual shared provider component:
starting or cancelling sign-in preserves the selected provider's settings,
confirmation remains unavailable until verification, successful confirmation
selects the newly saved provider, and older hosts without the setup feature do
not show an unsupported sign-in action. These checks use a synthetic transport
inside the isolated smoke renderer and do not contact a provider.

T3's collaborative browser used the actual desktop renderer, controller, SDK
host and a synthetic native executable in a separate private profile. It checked
waiting with a device code, refresh preserving the attempt, no confirmation
button before verification, account identity before saving, explicit confirmation,
unchanged execution grants and visible reported models. Desktop and 390 × 844
views had no page overflow. Device interactions were absent from browser storage.
The fixture did not open or authorize a live provider account.

The new native setup suite runs in the existing Prometheus-only Codex CI job;
desktop packaging retains its non-root, offline Debian native smoke. Exact CI
run/artifact evidence is recorded on issue #50 after the source is pushed.
