# Desktop remote connection recovery — 2026-09-27

Issue [#55](https://github.com/agenticdriver/agenticdriver/issues/55) adds
destination previews, authenticated connection checks, saved-host names and
same-address reconnection. These changes follow the published alpha.3 and require
a newer desktop build; they are not present in the immutable alpha.3 release.

## Checks

- Eleven desktop backend/security tests pass. The new tests use real isolated
  SDK hosts and an HTTP proxy fixture. They cover no-network invitation parsing,
  authenticated protocol-only checks, expiration, revocation, incompatible
  responses, network failure and private-token redaction.
- Replacement tests preserve the old profile after failed exchange and after a
  simulated settings-write failure. Successful replacement survives a controller
  restart, preserves the host ID/name, uses the new grant and leaves the old
  credential intact. Destination mismatch is rejected before exchange.
- Native Electron development and packaged builds pass at 1340×883 and 390×844
  content viewports. The real forms preview invalid/valid invitations, connect,
  rename, check an offline host, recover after host restart, detect revocation
  and reconnect while preserving the saved preference scope. No horizontal
  overflow is present at either size. Packaged renderer isolation and strict
  style CSP remain enabled.
- Native screenshots of the saved-host and connection forms were inspected at
  both widths. T3 browser metadata remained available, but its interaction tools
  reported no attached automation host. No T3 browser interaction or keyboard
  acceptance is claimed for this change.
- The Prometheus workflow now runs the packaged native smoke at both sizes.
  Its run receipt is recorded on the issue after completion.

Only synthetic grants and profiles were used. No provider sign-in, live inference,
application data, shared host service or installed desktop session was changed.
TLS diagnostics were tested with nested certificate-error fixtures; the existing
verified-HTTPS deployment tests remain a separate CI gate. The connection check
confirms credential acceptance, not model qualification or continuous presence.
