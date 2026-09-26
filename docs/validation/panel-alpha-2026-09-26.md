# Shared panel alpha consumer checks — 2026-09-26

Brandstorm's adoption review found that the shared panel's inline styles were
incompatible with Companion's `style-src 'self'`, and that provider removal was
missing. The 0.2.0 alpha candidate addresses both in the shared SDK.

The component now installs a constructed shadow stylesheet and uses CSS classes
instead of inline attributes. Its browser asset remains identical across
TypeScript, Python, Go and Rust. The standalone loopback panel also serves its
page CSS externally and has removed `unsafe-inline` from its style policy.

The T3 collaborative browser exercised a synthetic local fixture under
`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`,
with the remaining image/base/form/frame restrictions matching Companion.
At 1920×1080 the computed layout was a two-column grid; at 390×844 the page stayed
390 pixels wide and switched to one column. Both screens were visually inspected.
No style-policy violations occurred. The shadow root contained no inline style
elements or attributes. These checks used synthetic state and no real credentials.

Browser interactions verified:

- Removal asks for confirmation and initially focuses **Keep provider**.
- Cancelling leaves the instance present.
- A concurrent revision change returns 409 and preserves the instance.
- Refresh followed by confirmation removes the selected instance.
- Older-host metadata without `removalSupported`, and read-only connections,
  omit the removal control.

The native desktop smoke now installs an additional `style-src 'self'` policy,
checks the rendered grid and policy-violation events, and exercises cancellation
and confirmed removal through the real desktop IPC/backend. Its successful
receipt includes `providerRemovalUi: true` and `strictStyleCsp: true` alongside
the existing sign-in UI and renderer-isolation checks. Prometheus repeats this
against the packaged Linux archive.

Local validation passed: 338 SDK tests, seven desktop tests, native desktop smoke,
and installed TypeScript, Python sync/async, Go and Rust blocking/async clients
over HTTP and certificate-verified HTTPS, including their panel bridges. Tests
cover removal's revision/authorization checks, stored key and grant preservation,
empty management hosts, and active-run account/usage continuity. A provider
referenced by a static host grant fails with `PROVIDER_IN_USE`; no grant or
operator-owned account policy is silently rewritten. Extensions stay operator-owned.

This report qualifies component behavior, not model availability or inference.
There were no new real-provider requests. Release-source identity, immutable
artifacts and final Prometheus evidence belong to the alpha release manifest
and publication receipt; the earlier `f76801f` candidate predates these fixes.
