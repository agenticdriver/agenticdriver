# Desktop-managed SSH validation — 2026-09-28

Implementation is tracked in [AD-015 / #63](https://github.com/agenticdriver/agenticdriver/issues/63).
This record covers the source preview, not the earlier immutable alpha.4 release.
The issue records the exact pushed source and subsequent Prometheus verification.

## Native transport

The real OpenSSH client/server fixture generates temporary host and user keys,
pins its own host key, and opens only loopback listeners. It exercises the packaged
desktop controller and SDK with synthetic configuration:

- Scoped pairing, authenticated provider/protocol reads and rejected invitation
  replay; no model request.
- Explicit same-port restart preserving the existing application grant, followed
  by revocation rejecting new access.
- Unknown and changed host keys, rejected user authentication, denied forwarding,
  and occupied ports. There is no trust bypass, alternate port or retry fallback.
- Suppression of ambient forwards and native local/remote commands; SSH receives
  only its native identity environment, excluding provider keys and preload hooks.
- Worker IPC loss closes the supervised SSH session. Local host shutdown closes
  its tunnels. Saved configurations remain stopped across desktop restart.
- An authenticated unfinished request body prevents ordinary tunnel removal,
  tunnel stop and desktop close; explicit interruption cleans up the request.
- Editing requires a stopped route, retains its ID, and never starts SSH.

All sixteen desktop tests passed on the development machine. The native transport
fixture also passed in the packaged Linux image as a separate, unprivileged user,
with networking disabled outside that container. CI requires OpenSSH in that image;
an absent binary cannot turn the qualification step into a skipped pass.

The opt-in two-machine script used the existing `prometheus` SSH destination and
a temporary mock-only desktop profile. The application-side Python client reached
the local SDK through desktop-managed outbound SSH. Linux socket inspection
confirmed a `127.0.0.1`-only listener. Protocol `1.0`, scoped provider discovery and
replay rejection passed. The temporary grant was revoked, the tunnel closed and
the profile removed. No real provider payloads or application data were sent.

## Desktop interaction

Development and packaged native Electron checks passed at desktop size and
`390 × 844`, including saving/editing/removing a route, refusing invitations for
a stopped route, existing host credential recovery, native keyboard submission,
renderer sandboxing and strict component style policy.

The T3 collaborative preview also saved and started a synthetic route to
Prometheus, selected **Use for invitation**, and stopped it. The displayed
destination matched the server-side loopback port. A stopped route disabled
invitation creation. The wide screenshot was inspected; narrow DOM measurement
showed no horizontal overflow. T3's narrow screenshot operation failed, so that
specific screenshot is not claimed as evidence; native narrow checks passed.
The test route and private preview were closed afterward.

These observations qualify Linux OpenSSH transport and the desktop workflow,
not provider inference, application production acceptance, or arbitrary SSH
server policy. The SSH server remains a trusted encryption endpoint and must
honor loopback binds. No keys, known-host entries, SSH server settings, firewall
rules, shared application hosts or connection grants were changed outside the
temporary fixtures.
