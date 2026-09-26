# Codex MCP application tools — 2026-09-26

The opt-in production adapter was exercised against the actual Linux x64
Codex **0.157.0** executable with synthetic credentials, a local Responses
fixture and no external network. This qualifies the protocol and controls;
it is not live model/account certification.

The fixture covers a single tool round trip, concurrent duplicate tool names
with distinct call IDs, invalid whole-batch arguments, host approval rejection,
missing usage with a rejecting budget, cancellation during application work,
HTTP application execution and interactive approval/denial, and cancellation
at native proposal dispatch. Each successful round trip makes two fixture model
requests; denial and validation failures make one and execute no callback.
Application cancellation retains an uncertain-effect outcome.

Native processes and private working directories are gone before approval or
callback code runs. Continuation preserves each call's name, arguments and ID
alongside the matching result through the official
[`thread/inject_items` interface](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread).
The fixture checks the actual model request for native function-call/result
pairs and message roles. Reported token counts accumulate across model
steps; omitted counts do not become zero. The MCP helper never sends an
application result or waits for a human/callback inside native execution.

The fixture seeds ambient MCP and hook launch markers and verifies neither ran.
The effective native code-mode registry and globals are checked separately.
The existing native text-adapter and tool-protocol audits remain regression
coverage; their limitations still apply. Unit tests cover authenticated proposal
transport, exact duplicate matching, out-of-order delivery, oversized batches,
private manifests, unknown native servers and late unconfirmed proposals.

```sh
npm run build
python3 scripts/test-codex-native.py \
  --binary /absolute/path/to/the/pinned/native/codex \
  --suite application-tools --receipt /private/path/receipt.json
```

Prometheus's native CI job runs this suite alongside `adapter` and `tools`.
Watchdogs bound only the isolated test processes. Binary identities:

- `codex`: SHA-256 `1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258`.
- `codex-code-mode-host`: SHA-256 `ae34226adad3fe8acb361a78618e81b5a17638861bb7a689fcccaf8c3ef32aa8`.

The globally managed local CLI changed to 0.157.1 during qualification and was
correctly rejected. Tests use a separate pinned installation. The regular
LitAgent host's binary path was updated through revision-checked management to
that same qualified 0.157.0, restoring its nine reported Codex models without
restarting its service or changing credentials, grants or app selections. That
host remains text only; its application-tool permissions were not expanded.

An initial live smoke run on the explicitly selected `gpt-6-luna`, medium,
exposed a history problem in commit `300d740`: history serialized into user text
passed the protocol fixture, but the model requested the same lookup again.
The SDK stopped at its two-step limit before a second callback. The one completed
callback returned only synthetic data. Event
`3689e621-e8f5-43af-b488-3370aa1c231e` automatically reached a separate Usagestat
database with 44,615 input, 150 output and 20,992 cached input tokens. The failed
result is retained; it is not a successful live round trip. History now uses
native roles and completed calls, and its stronger offline fixture passes.
