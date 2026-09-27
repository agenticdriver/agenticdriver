# Shared provider panel recovery — 2026-09-27

Issue [#57](https://github.com/agenticdriver/agenticdriver/issues/57) corrects the
previously connected view remaining interactive after a failed snapshot refresh.
This change follows alpha.3 and requires rebuilding/updating the shared browser
module. The TypeScript, Python, Go and Rust panel request/response API is unchanged.

The component now hides stale provider details and actions while connection state
is unavailable. It retains the selected provider and local preference scope,
clears revealed identity/API-key/invitation state and offers an explicit metadata
retry. Sign-in-status polling failure enters the same state. No mutation, model
run, host pairing or provider/account selection is automatically repeated.

Validation uses the isolated native renderer with synthetic transport responses:

- Initial backend failure offers a retry without assuming permission to pair.
- A connected panel becomes unavailable after a failed snapshot, with no provider
  management, model selection, account reveal or sign-in confirmation controls.
- Recovery restores the same selected provider and icon preference; identity
  stays hidden. Applications denying disconnect retain that restriction.
- A failed native-sign-in status poll hides its confirmation/cancellation
  controls until refreshed. An application explicitly allowing disconnect can
  still forget the saved host from the unavailable view.
- A late failed refresh cannot overwrite a newer successful refresh.
- Existing provider setup, removal, model permissions, host pairing/reconnection,
  desktop route controls and strict style CSP checks remain in the native smoke.

The SDK typecheck, all 341 fixture tests and shared-asset build pass locally.
Packaged native, minimum/current runtime and language-client checks run on
Prometheus; the issue records their final receipt. Tests do not use live models,
real sign-ins, application data or shared host services.
