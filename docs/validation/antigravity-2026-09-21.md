# Antigravity native route readiness — 2026-09-21

**Decision:** native sign-in is confirmed, but this route is not ready for the
SDK's restricted text adapter or live application certification. Keep the
selected account; no new sign-in or API billing fallback is required.

The user selected Local Antigravity sign-in after the
[Gemini CLI personal route was rejected](gemini-cli-2026-09-21.md).
`gemini-3.8-flash-low` was explicitly pinned from `agy models` for synthetic
checks. The CLI's native onboarding picked up the existing Google AI Pro
sign-in, and the user separately confirmed the signed-in 1.2.7 CLI. No account
identifier or credential is retained here. No prompt was submitted and no
successful model response or token usage was observed.

Google documents CLI-native sign-in and a separate API-key mode. Its Python
SDK quickstart uses API credentials, so that SDK is not evidence of subscription
access. [CLI authentication](https://antigravity.google/docs/cli/install/),
[SDK quickstart](https://antigravity.google/docs/sdk/overview/).

## Verified native behavior

The official 1.2.7 Linux x64 release was checked on Fedora Linux 44. SHA-256:

- Archive: `e410dd56d8c213ef12643d3ff5eaaab57a17e05bbf72e9415322f23879fc4a18`.
- Binary: `9991515b6d5307bcf701069622b0537b6b206e605f3c891c0cf3a3d208dea8b0`.

Its help explicitly describes `--print-timeout 0` as unlimited; the official
changelog records that default change in 1.2.6. Older five-minute headless
defaults must not silently become SDK run deadlines.
[Release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.7),
[changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md).

A temporary configuration supplied an explicitly selected custom agent with
`tools: []`, `excludeDefaultComponents: true`, `inheritCustomizations: false`,
no MCP/skills/plugins, and strict permissions. Initialization reported the
requested agent and model, but still advertised **57 tools**, including shell,
file editing, browser, MCP and subagent operations. The probe closed stdin
without sending any user event. It observed no tool invocation. This is an
advertised-capability mismatch, not evidence that a tool executed or escaped
isolation.

The sanitized event is in
[the regression fixture](../../tests/fixtures/antigravity-1.2.7-init.json).
The vendor tracker reports the same mismatch on earlier versions; our result
independently reproduces it on 1.2.7. We cannot treat the requested empty tool
list as an enforceable boundary from this evidence.
[Upstream issue #1015](https://github.com/google-antigravity/antigravity-cli/issues/1015).

## Reproduce without inference

From this SDK checkout on Linux with Bubblewrap installed:

```sh
npm ci
npm run check:antigravity -- \
  --binary /absolute/path/to/reviewed/agy \
  --model gemini-3.8-flash-low
```

The checked 1.2.7 binary returns exit 1 and:

```json
{
  "toolCount": 57,
  "modelMatches": true,
  "agentMatches": true,
  "strictPermissions": true,
  "status": "unsupported-tools",
  "promptSubmitted": false,
  "liveCertified": false,
  "version": "1.2.7"
}
```

This source-only maintainer probe mounts the reviewed binary read-only, uses
temporary settings and a temporary home view, excludes inherited API credentials,
and deletes its files after reaping the child. It does not inspect user
credentials, import account configuration or change persistent preferences.
Native startup may contact Google for configuration; stdin never receives a
prompt. The 20-second inspection bound is housekeeping, not a run deadline.
Raw output, arbitrary tool names, paths and account identifiers are not returned.

`ready-for-live-check` only means that this initialization check passed. It
does not validate account eligibility, generation, tools, usage, streaming or
cancellation during inference. The native probe currently runs on Linux;
subprocess/parser fixtures are credential-free. See the documented
[headless input protocol](https://antigravity.google/docs/cli/headless/).

## Follow-up

[AD-051](https://github.com/hashimkarim/agenticdriver/issues/28) tracks readiness
and this compatibility gate. [AD-052](../roadmap.md#ad-052) tracks the restricted
adapter and live certification once the official interface exposes enforceable
effective capabilities. Keep the selected Local Antigravity account/model for
that work. Brandstorm, LitAgent and AI Workspace retain their separate live
acceptance criteria; successful sign-in and fixture tests do not satisfy them.
