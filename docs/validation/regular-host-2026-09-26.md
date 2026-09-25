# Regular host and default model access — 2026-09-26

The separate regular LitAgent host now runs the exact npm artifact built and
installed by [Prometheus CI 36195341842](https://github.com/agenticdriver/agenticdriver/actions/runs/36195341842)
from commit `23e79543143c9f856978ee4923525942802014ca`. All seven jobs succeeded
on `prometheus-agenticdriver-01`; no hosted runner was used. Artifact SHA-256:
`9bdefd06328db11063699aaf0ff5e1f7a5ca6ff44b68d468f4768c42f90e9523`.
This is an unpublished source candidate, not the registry's original 0.1.0 host.

The existing private application token and its lifetime are unchanged. Its
`litagent-local` subject can use these configured connections:

| Provider instance | Account scope           | Native runtime      | Reported IDs at readback | Execution permission |
| ----------------- | ----------------------- | ------------------- | ------------------------ | -------------------- |
| `local-codex`     | `selected-local-codex`  | Codex 0.157.0       | 9                        | `models` omitted     |
| `local-claude`    | `selected-local-claude` | Claude Code 2.1.282 | 14                       | `models` omitted     |

Omission permits any explicitly selected model, subject to the provider accepting
it. `models: []` still denies all execution; a nonempty array restricts it. The
reported inventories remain advisory and can change on refresh without changing
application enablement or selection. The application credential still receives
403 from management and has no tool, job, session or retrieval grants. A separate
management-only operator profile can use the provider panel. Private credential
paths, startup details and rollback instructions were handed to the owning app
thread and stored in the host's local README, never as token contents.

Two minimal synthetic checks establish only the selected model operations:

| Model and route                                    | Run/event ID                           | Result                                            |
| -------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `gpt-6-luna`, medium, native Codex sign-in         | `262e40b9-c2a9-47ac-bcba-b664e7b8b614` | Exact sentinel and automatic usage capture passed |
| `claude-haiku-4-5-20251001`, native Claude sign-in | `71a33362-35f9-453c-867d-f8f5d13435e2` | Exact sentinel and automatic usage capture passed |

Each successful check made one model request with one allowed attempt and no
application data or tools. An earlier malformed Codex validation request was
rejected by schema validation before execution. No provider/account/model or
billing fallback was used. Claude reported 3,607 input and 64 output tokens,
zero cached input and an API-equivalent cost of USD 0.003927. That last value is
native usage metadata, **not a subscription charge**.

The unchanged published `@agenticdriver/sdk@0.1.0` client installed in LitAgent
read the catalogs and performed the checks. No app dependency or authentication
migration was needed. The native context-suffix validators and embeddable panel
are newer source APIs and retain their separate candidate handoff.

Metering uses the existing Usagestat backend dependency at source
`80df24132db891b80587c63f07a3016606ccb5d3`, with its own regular-host database,
credential and explicit host/provider/account/subject bindings. Automatic capture
was verified by reading the original events; no manual insertion was used to
claim delivery. Duplicate handling and rejection of an unrelated subject were
also checked. A capture/read race was reconciled with metadata reads without
repeating inference. Polling is disabled; prompt/output bodies are not stored.

The regular host and metering service were updated only after confirming no
active client connections or provider child processes. The synthetic validation
host, its Usagestat service, scopes and credentials remained unchanged. Source
sync also preserved all 45 unrelated auth-cleanup paths; the combined local tree
passed 313 tests and installed-package checks.

This does not qualify every catalog entry or provider route. Gemini's selected
personal route remains unsupported, and its native metadata startup has a
[separate limitation](gemini-catalog-2026-09-26.md). Antigravity and Grok native
controls remain pending in their adapter work. API adapters require explicit
provider credentials; a native subscription is never silently reused as API
billing. Applications retain their saved choices and independently accept the
regular host integration.
