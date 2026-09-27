# 0.2.0-alpha.4 release candidate

Prepared on 2026-09-27 under
[issue #59](https://github.com/agenticdriver/agenticdriver/issues/59).
Publication is pending. Previous releases remain immutable; alpha.3 remains the
published application preview until the new channels are independently verified.

## Included changes

- Desktop invitation destinations explicitly select same-computer, HTTPS or an
  existing SSH tunnel, including proxy path prefixes and forward/reverse recipes.
  Parsing a destination does not contact it or send an operator credential.
- Saved-host checks use authenticated protocol metadata. Credential replacement
  at the same address preserves host identity, preferences and the prior profile
  on failure. Setup distinguishes expiration, rejection, network and TLS errors.
- The shared provider component enters an unavailable/retry state after failed
  refresh or sign-in status polling, hiding stale account and provider controls.
  A disconnected snapshot retaining a saved connection enters the same state
  rather than first-time onboarding. Recovery retains selection/preferences and
  keeps identity hidden. Native T3 acceptance found this additional edge case;
  [issue #60](https://github.com/agenticdriver/agenticdriver/issues/60) owns its fix.
- Prometheus CI runs its nine checks sequentially on the existing runner. The
  packaged native UI is checked at wide and 390×844 sizes with native Enter-key
  form submission.

The functional source before versioning,
`985733b7042c737d0d9a1d91c4aa5d7696e05267`, passed
[all nine Prometheus checks](https://github.com/agenticdriver/agenticdriver/actions/runs/36325572573).
Local evidence covers 341 SDK tests, 14 desktop tests, all four language clients
over HTTP/verified HTTPS, and a temporary reverse SSH route to Prometheus with
one-use replay rejection and loopback-bind inspection. See
[connection recovery](remote-connections-2026-09-27.md),
[invitation destinations](invitation-destinations-2026-09-27.md) and
[panel recovery](panel-recovery-2026-09-27.md). No model calls were made. T3 browser
automation was unavailable during that earlier source validation.

Additional native T3 acceptance for issue #60 used a separate disposable desktop
preview and mock-only remote host. Invitation preview, native Enter submission,
protocol-only connection checks, saved-host rename, host shutdown and explicit
recovery passed. At the measured 2103×1183 viewport, the offline saved host kept
its ID and selected provider, showed recovery without onboarding or stale
management controls, and restored the same provider after retry. Browser resize
timed out, so this is desktop-width T3 evidence only. Native Electron regression
checks passed at both 1340×883 and 390×844, alongside 341 SDK and 14 desktop tests.
These checks used synthetic providers without inference, real account data or
shared-service changes.

That earlier CI does not qualify the newly versioned release source. The exact
release commit, its own CI run, archive hashes, publication and fresh installation
receipts will be recorded here after they pass.

## Compatibility and destinations

The planned npm, Rust, Go and Linux x64 desktop version is **0.2.0-alpha.4**;
Python uses **0.2.0a4**. Protocol **1.0**, the panel API and the independently pinned
provider-icons `v0.1.0-alpha.1` stay unchanged. No app auth migration, provider sign-in,
model call, execution-grant expansion or shared-host restart is part of adoption.

Selected destinations remain npm `@agenticdriver/sdk` on `alpha`, crates.io
`agenticdriver`, the public organization Go module and GitHub release downloads.
Stable npm `latest` stays at 0.1.0. Python remains a GitHub wheel/sdist while the
selected PyPI organization's approval is pending; no personal publisher is used.

An updated client does not upgrade an already running host. All three app owners
must receive exact immutable coordinates and run their own application checks
after publication. Existing auth stacks, private credentials, Usagestat bindings,
model choices and grants remain in place. No default inference deadline or
inactivity timeout, model/account/billing fallback, public relay, automatic
updater or newly qualified desktop OS is introduced.
