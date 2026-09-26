# Provider sign-in

The desktop and shared provider panel can guide **Codex device-code sign-in** on
a connected local or remote host. The official native runtime exchanges and
stores credentials. AgenticDriver receives a device interaction and verified
account metadata; it does not extract provider tokens or browser cookies.

This is a source-preview feature on `sdk-roadmap`, included in desktop
`0.1.0-alpha.2`. Published SDK `0.1.0` predates it. Other native providers retain
their existing-session setup until their own integration is qualified. API keys
continue to use the existing write-only host credential store.

## Connect an account

1. Select the intended host, then **Add provider → Codex → Sign in with ChatGPT**.
2. Name the connection. In **Advanced settings**, select the qualified Codex
   **0.157.0** executable if the host's `codex` command is a different version.
   The host currently needs Linux x64 and a persistent `usage.hostId` in its
   configuration. CLI bootstrap and desktop-created hosts supply that identity.
3. Choose **Start sign-in**, open the official ChatGPT device page, and enter the
   displayed code. The account must permit Codex device-code authentication.
4. Return to the panel. After Codex completes sign-in and a fresh `account/read`
   verifies the account, inspect the displayed identity and choose **Confirm
   account**. **Cancel sign-in** stops only this attempt.

The browser opens `https://auth.openai.com/codex/device`; no callback listener
or SSH port forwarding is needed for this method. For remote hosts, the app's
backend still needs a reachable, certificate-verified HTTPS connection to the
host. Metadata polling keeps the same attempt visible when the panel refreshes.

A separate private account directory is created for every attempt. Existing
shared CLI accounts are never signed out or replaced. Confirmation adds a new
provider instance with the reviewed account ID; leaving that ID blank in the
panel generates a stable one. New instances allow all explicitly selected
models unless an override was supplied. Existing application grants remain
unchanged. Account verification does not imply quota, model availability or live
model qualification, and no model prompt is sent by this workflow.

## SDK contract

Discover `provider-setup` in `client.protocol().features` and the `codex-device`
method in `management.providerDefinitions`. Both require `manageProviders`.
The method's interaction is `device-code`, with credential owner
`native-runtime`. The definition is setup metadata, not proof that the executable
is installed or the account can authenticate. Older hosts omit the feature; the
panel hides the unavailable method.

| Language              | Operation                            |
| --------------------- | ------------------------------------ |
| TypeScript            | `client.providerSetup(request)`      |
| Python sync / async   | `client.provider_setup(request)`     |
| Go                    | `client.ProviderSetup(ctx, request)` |
| Rust blocking / async | `client.provider_setup(&request)`    |

Every operation uses `POST /v1/management/setup`. Typed `ProviderSetupRequest`
and `ProviderSetupSnapshot` contracts are provided in each package.

```ts
const settings = await client.management();
const started = await client.providerSetup({
  action: "start",
  revision: settings.revision,
  method: "codex-device",
  provider: {
    kind: "codex",
    id: "codex-work",
    name: "Work account",
    accountId: "work-account",
    binary: "/absolute/path/to/qualified/codex",
  },
});
const id = started.attempts[0].id;
const status = await client.providerSetup({ action: "status", id });
// Display status; only offer confirmation after phase === "ready".
// On the user's confirmation:
await client.providerSetup({ action: "accept", id });
// Or, while pending:
// await client.providerSetup({ action: "cancel", id });
```

`{ action: "list" }` returns only this credential's attempts. All responses have
`{ version: 1, attempts: [...] }`. Single-attempt operations return exactly one
matching attempt; clients reject mismatched provider/account/revision or attempt
IDs. A setup attempt contains:

- Opaque ID, provider/account IDs, name, method and starting configuration revision.
- `starting`, `waiting`, `verifying`, `ready`, `succeeded`, `failed`, `cancelled`
  or `expired` phase, with creation/update/expiry timestamps.
- While waiting, the official verification URL and device code.
- After native verification, account email when reported, plan and optional
  native account ID. `ready` still requires explicit acceptance.
- Fixed public error codes/messages on failure, without native diagnostics.

The shared panel bridge forwards `{ action: "setup", request }` and includes
optional `setup` in its snapshot. Device codes and account metadata stay in
memory; they are not model preferences or browser storage. Backend routes must
retain the consuming application's existing settings authorization, CSRF
protection, no-store responses and body-log redaction.

## Ownership and lifecycle

The host binds each attempt to the authenticated principal and the exact
transport credential. Another administrator, a rotated credential, or a forged
caller field cannot inspect or complete it. Applications that deliberately share
one service credential also share that setup caller; use separate management
connections when users must not share interactions.

The provider/account/method and revision are immutable. Existing provider IDs
cannot start replacement sign-in. A host configuration change invalidates a
pending attempt. Confirmation checks the original revision again through the
normal atomic configuration writer. A replay of acceptance or cancellation is
rejected. Call `status` to reconcile a lost acceptance response; do not blindly
retry the mutation.

The device authentication lifetime is 15 minutes, matching the native flow.
This is credential expiry, **not an inference deadline**. No run, tool or idle
timeout is introduced. At most four attempts are pending per host and two per
caller; the host retains at most 32 process-local receipts. Listing metadata
does not start sign-in, refresh provider credentials, or cancel model runs.

Graceful host shutdown, cancellation, expiry and failed setup stop the owned
process and remove its unpublished profile. Confirmed profiles remain private
under `provider-accounts/codex-*` and the committed provider configuration
references them. The native runtime owns subsequent credential refresh.
Attempts do not resume after a process crash. A crash can leave an unreferenced
private profile; reconcile it against the host configuration with the host
stopped before removing it. Shared or confirmed profiles must be preserved.

## Qualification

The native contract follows the pinned official
[Codex account processor](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/app-server/src/request_processors/account_processor.rs)
and [device authentication implementation](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/login/src/device_code_auth.rs).
`account/login/completed` alone is insufficient: the SDK performs a separate
native `account/read` before offering confirmation.

The [dated validation record](validation/provider-sign-in-2026-09-26.md) separates
the actual-native offline protocol check, HTTP/TLS client checks, UI fixtures and
live-account qualification. The native fixture uses an isolated loopback test
issuer and explicitly translates its verification URL for the production
allowlist; it does not certify Google's, Anthropic's, or OpenAI's live login UI.

```sh
npm run build
python3 scripts/test-codex-native.py \
  --binary /absolute/path/to/native/codex --suite setup --receipt /tmp/setup.json
```

The test harness requires Linux, bubblewrap and the complete pinned native
installation. It hides the real home, disables external networking, verifies
native exchange/storage and caller-bound SDK lifecycle, and sends no model calls.
