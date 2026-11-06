# Installed Antigravity SDK qualification — 2026-11-06

Development source now supplies the `antigravity()` text adapter. An independently
installed development archive completed a real SDK run through `configuredDriver`
using the existing local native profile and exact **gemini-3.8-flash-low** model.
No API credential, alternate account or model fallback was supplied. Native CLI
**1.5.1**, Linux x64 and Bubblewrap were used. The actual account plan/charge was
not reported; catalog discovery retains account status `unknown`.

## Artifact and enforced boundary

The development archive was built from SDK commit `6e92cceef0e8a81f0c54edb28704dcff1cd49d18` and installed into a
fresh private consumer, without sibling source imports. Archive SHA-256:
`5e0bd3c3b4bcc5ed3a279cbee82abe270606eb8af130b2a87001f6d9576c0beb`.
Its package metadata remains RC.3; these are development bytes, not published
RC.3 host bytes. No registry release was performed.

The advertised native tool catalog is not used as permission. Each operation
loads a private configuration with owned deny-all `PreToolUse` hooks and native
strict resource-deny rules. Native credentials are read-only mounts from the
selected profile. The owned hooks/settings/control files are read-only in the
native view. Before application content, the same process must finish a blocked
control turn with zero reported usage, matching owned nonce and mounted executable
version. Only one application model invocation is permitted. Any native tool step
fails the SDK run; application tools remain unavailable.

The current operator check runs this exact production startup owner and returns
`ready-for-live-check`, `nativeToolPolicy: deny-all`, `modelInvocations: 0` and
`applicationPromptSubmitted: false`. It closes before application inference.
The historical empty-catalog gate was removed rather than retained as a parallel
readiness implementation.

## Actual SDK requests

The corrected qualifier made two distinct requests, each bounded to one SDK step
with no retries:

- **Acceptance:** draft an email from supplied facts explaining published RC.3
  versus unreleased development features, preserve account/model selection and
  require application acceptance before upgrading. The SDK streamed and completed
  the grounded draft. Parent review confirmed it did not claim tests, adoption
  or sending had happened. Usage: **7,189 input / 153 output / 0 cached / 0
  reasoning tokens**, source `cli-report`, auth mode `cli-session`, one completed
  SDK step. No email was sent.
- **Native-action rejection:** ask the brand-workspace assistant to save a
  Markdown brief for an 18L repairable Amsterdam commuter backpack with explicit
  audience, material, buckle, laptop and price constraints. The SDK observed a
  native tool proposal and failed with **CLI_POLICY_VIOLATION**. No application
  callback was supplied. The native operation was interrupted and reaped; reported
  usage for this failed request is unknown, not zero.

After both cases, the dedicated runtime directory contained no operation
subdirectories and no owned native process remained. A separate earlier isolated
real canary established actual pre-tool denial: `write_file` emitted an error
stating it was denied by the owned hook, and no target file appeared. That spike
also showed `PreToolUse` before `PostInvocation`; post-invocation termination is
not an execution barrier by itself.

An earlier installed-SDK harness mistakenly iterated the `run()` convenience
promise instead of `stream()`. Its asynchronous request was not captured by the
qualifier, so that request remains unverified with unknown dispatch/usage within
a one-request bound. It was not retried. The corrected qualifier used a distinct
email task and persisted events and the host usage log independently before
closing its journal.

## Review, checks and limits

Independent source review found no concrete tool-execution bypass. Its missing
sign-in diagnostic finding was fixed: absent selected native auth state returns
`CLI_AUTH_REQUIRED` without account fallback. Focused host/CLI and owned-hook
checks passed; the full check passed **88 tests**, with one existing live
Usagestat skip, plus typecheck and build. The hook regression covers denial of
file, command, web, internal-task, subagent, unknown MCP and future tool names,
as well as malformed configuration. These pure helper checks are not substitute
model evidence.

This qualifies the recorded text workflow and native-action rejection on this
Linux route. It does not qualify application tools, native session continuation,
images/PDF inputs, other platforms/runtimes or hostile-tenant OS isolation.
The separate cancellation follow-up below records its narrower actual scope. User/project customizations are isolated, while the
native runtime and execution host remain trusted. No default model deadline is
added; print timeout stays disabled. Actual billing cost is unknown.

Private corrected receipt SHA-256:
`7e2ab875de135a474f2e7cef1729164126bb3d6d56e614cc8bc984dd9f97c823`.
Durable event journal SHA-256:
`b69863ec945144c0e2a883cd3c86d355c44c38a76b5877a7d57c923f3f9a1aec`.
Earlier unverified harness receipt SHA-256:
`44ee61c33d21445ddca3bfe42b1fb0adb4128d4745505fe9c51454bfe7b75db3`.

## Active cancellation follow-up

The same installed archive later ran a distinct long email-workspace acceptance
plan and cancelled immediately after the first actual SDK text delta. Three owned
native processes were present at abort. The SDK emitted `run.cancelled`; after
stream completion no owned native process remained. The remaining temporary
operation directory disappeared during a 269 ms cleanup observation. This is
local process/directory cleanup evidence, not proof of remote compute cessation.
The cancelled step reported no complete usage, so tokens and billing remain
unknown. There was no retry. Private receipt SHA-256:
`85e89f5d4a836a87bcdd94f5b52d00d1c66d55de959b6debf8c35e2e8d84d9b6`.
