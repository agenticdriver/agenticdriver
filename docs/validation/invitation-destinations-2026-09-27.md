# Desktop invitation destinations — 2026-09-27

Issue [#56](https://github.com/agenticdriver/agenticdriver/issues/56) adds explicit
same-computer, HTTPS and SSH-tunnel invitation destinations. This is unreleased
desktop work following alpha.3. The shared invitation wire format and four
language clients are unchanged.

Fourteen desktop tests pass, including these new checks:

- Destination previews create no grants. Insecure URLs, embedded credentials,
  queries/fragments and invalid tunnel ports fail before any invitation is issued.
- A real TCP loopback-forwarding fixture exchanges and reconnects through its
  application-side port, without changing the host listener or saved host ID.
  This represents an already established tunnel; it does not qualify an SSH
  daemon, SSH account or remote server policy.
- A generated private CA signs an HTTPS proxy's leaf certificate. A fresh Node
  client with explicit CA trust pairs, reconnects and reads the provider panel
  through `/driver/`. An untrusted client and a trusted client using the wrong
  hostname are rejected before exchange. TLS verification is never disabled.
- The proxy observes only invited client credentials. Destination preview and
  invitation creation never send the operator credential to that address.
- The isolated native desktop smoke exercises all three route controls, invalid
  HTTPS input, actual invitation creation, stale-invitation clearing, proxy-prefix
  display and both SSH command directions at wide and 390×844 viewports. The
  forms fit without horizontal overflow and pass the consuming application's
  strict style CSP.

SSH recipes follow the [OpenSSH manual](https://man.openbsd.org/ssh.1), explicitly
request loopback binds, use `-N` and fail initial forwarding setup via
`ExitOnForwardFailure=yes`. They are displayed for the user to run with existing
SSH access; AgenticDriver does not spawn SSH or claim the route is verified.

All data, credentials and hosts in these checks are isolated fixtures. No real
provider account, model, application data, firewall, shared service or installed
desktop session was changed. Prometheus runs the packaged smoke at both sizes;
the issue records the final CI receipt. T3 browser interactions remain unavailable
because no automation host is attached.
