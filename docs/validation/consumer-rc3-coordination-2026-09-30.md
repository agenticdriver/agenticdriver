# RC.3 consumer coordination diagnosis — 2026-09-30

Tracking: [AD-086 / #83](https://github.com/agenticdriver/agenticdriver/issues/83).
This records the existing automatic rollout's actual failures. It does not
replace app acceptance or create a second migration workflow.

The configured release watch discovered immutable SDK source
`f319f173f55069a2ca0f91969bac99c169a063d2` and the verified RC.3 archive. Rollout
`rollout_69faf723d8aeb5b1`, feature `feat_d00c323b06664d19`, currently has four
blocked consumer tasks. Each has one recorded attempt; no worker remained active
at inspection. Their existing source/attempt/check identities are retained.

| Consumer                   | Observed blocker                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| LitAgent                   | Selected task packet exceeds the 100 KB driver input cap.                                                             |
| Agent Orchestrator tooling | Selected task packet exceeds that cap.                                                                                |
| AI Workspace               | Selected tests import implementation paths absent from the allowed packet, and relevant SDK declarations are missing. |
| Brandstorm                 | Relevant SDK subpath declarations are missing; READMEs alone do not establish the consumed contracts.                 |

AI Workspace's tests use `src/integrations/driver-settings.ts`,
`src/integrations/settings-host.ts`, `src/integrations/mail-triage.ts` and
`src/remote-triage.ts`. Its selected `src/driver-settings.ts` and
`src/driver-connection.ts` entries are absent. An agent must not guess or edit
outside the declared scope to conceal that mismatch.

## Verified SDK contracts are available

The released archive already contains the declarations for the consumed exports:

| Export                           | Declared type entry     | Bytes |
| -------------------------------- | ----------------------- | ----: |
| `@agenticdriver/sdk/client`      | `dist/client.d.ts`      | 6,064 |
| `@agenticdriver/sdk/catalog`     | `dist/catalog.d.ts`     | 2,890 |
| `@agenticdriver/sdk/connections` | `dist/connections.d.ts` | 1,422 |
| `@agenticdriver/sdk/panel`       | `dist/panel.d.ts`       | 7,740 |
| `@agenticdriver/sdk/context`     | `dist/context.d.ts`     | 5,032 |

These entries total 23,148 bytes before referenced declaration dependencies. Their
paths and SHA-256 values were checked against the exact published package, whose
archive SHA-256 is
`23db3a8269357b1e4f2568a4836588c3c70e8bf60e3869e5d940b362ebe3f070`.
The reported migration packets supplied README reference text rather than these
contracts. The inspected coordinator source selects `index.d.ts`/README entries
and trims the migration reference collection to two entries. Its reference
selection needs a bounded closure for the actually consumed exports.

## Required repair and preserved authority

Keep every consuming manifest, exact lock/archive input and registered
integration check. Select the actual focused implementation files, and avoid
sending unnecessary large test bodies when their checks can run from the pinned
checkout. Verify packet size before new inference. A passing check against an
old installed dependency is not target-version acceptance.

Started-task scopes are fixed: `task.configure` rejects them. The supported
attached-owner narrowing operation requires a live lease, preserves immutable
input bindings and cannot add missing paths. The current four managed tasks
therefore need a supported audited revision/ownership repair by the coordinator
owner. Their database must not be edited directly. Creating replacement tasks,
publishing a duplicate SDK version or resetting budgets would lose the failure
history and is not a repair.

No app source, task scope, attempt allowance, model/account selection or
execution grant was changed during this diagnosis. No model call or retry was
requested. RC.3 SDK publication and the local desktop upgrade remain complete;
the three apps retain their [accepted RC.2 workflows](release-0.2.0-rc.2.md)
until exact RC.3 adoption passes its own gates.

[Public coordination receipt](../../release/0.2.0-rc.3/consumer-coordination.json)

## First repair is under review

The [Prometheus Looper pilot](looper-pilot-2026-09-30.md) now owns
[Agent Orchestrator #26](https://github.com/hashimkarim/agent-orchestrator/issues/26)
for the bounded verified declaration collection repair. Its real native Codex
worker used `gpt-6-luna` with medium reasoning in an independent worktree and
opened [draft PR #27](https://github.com/hashimkarim/agent-orchestrator/pull/27).
Independent Prometheus checks passed, but review found incomplete import/path
handling and requested a bounded fix pass on that draft. The actual RC.3
declaration closure remains larger than the reference budget.
Repository-wide discovery and automatic merging are disabled. The original
consumer migration scopes and attempts remain unchanged; packet packing, audited
scope repair and exact RC.3 app acceptance remain outstanding.
