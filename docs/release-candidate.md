# Release candidate gate

**0.2.0-rc.3 passed its scoped gates and is published.** This candidate adds
the desktop Overview and explicit local/remote Codex runtime installation to
RC.2's scope. [AD-083 / #80](https://github.com/agenticdriver/agenticdriver/issues/80)
tracks exact-source artifacts and publication. The [RC.3 receipt](validation/release-0.2.0-rc.3.md)
records all seven Prometheus checks, exact public artifacts and registry
provenance, the installed desktop upgrade and separate application handoffs. The
[managed runtime receipt](validation/managed-runtime-2026-09-30.md) records real
installation, cancellation, restart, language-client status and the selected Luna
brand prompt. Python uses **0.2.0rc3**; protocol remains **1.0**. The three apps'
accepted workflows currently remain RC.2 evidence; RC.3 publication does not
automatically establish app acceptance.

After publication, the released **Usagestat 2.0.1** binary passed separate
[compatibility and retained-state maintenance](validation/usagestat-2.0.1-2026-09-30.md).
The SDK-owned regular ingestion service now runs 2.0.1 with all thirteen original
records and its private configuration retained; the execution host and ordinary
usage daemon were preserved. SDK RC.2 and RC.3 both verified scoped readback.

**0.2.0-rc.2 passed its scoped gates and is published.** It corrects native quota
reads and qualifies the released Usagestat 2.0.0 ingestion contract. Python uses
**0.2.0rc2**; protocol stays **1.0**. Artifact source:
`91dc52292c627a6febed102a8198c56f35d3afc9`.

The [RC.2 receipt](validation/release-0.2.0-rc.2.md) records all seven Prometheus
source checks, exact registry/public-download verification, real Codex and Claude
capture, and all three app-owned registry migrations and metered workflows. The
normal LitAgent host and usage service preserve all thirteen stored records and
existing credentials/grants; the local desktop preserves its original profile.
Use [RC adoption](rc.md) for installation and host/client upgrade order.

Current scoped limits include pending PyPI organization approval, the earlier
provider/platform restrictions, and a [single Brandstorm selection propagation
observation](https://github.com/hashimkarim/brandstorm/issues/3) whose reproduction
is pending. SDK model selection emitted its event; no SDK-owned defect is proven.
Do not claim first-click Brandstorm setup fully qualified. Wider retrieval,
security and cancellation checks below remain the historical RC.1 baseline.

## RC.1 accepted baseline

**0.2.0-rc.1 passed its scoped release gates and was published on 2026-09-29.**
Python uses **0.2.0rc1**; wire protocol remains **1.0**. Tracking:
[#71](https://github.com/agenticdriver/agenticdriver/issues/71).
The immutable artifact source is `726fd821a31d7c4462db36bfdf3884ab028f9b7a`.

Use [RC adoption](rc.md) for installation and connection setup, the
[public release](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.1)
for downloads, and the [complete receipt](validation/release-0.2.0-rc.1.md)
for artifact hashes, actual runs, source comparisons, CI and qualification limits.
Stable npm `latest` remains **0.1.0** and `alpha` remains **0.2.0-alpha.6**.

## Qualified scope

The RC covers the Linux x64 host and desktop, TypeScript/JavaScript, Python, Go
and Rust clients, and the explicitly selected Codex/Claude subscription routes
through local execution, trusted OpenSSH or verified HTTPS. The exercised models
are Codex **0.157.0 / gpt-6-luna / medium** and Claude Code
**2.1.282 / claude-haiku-4-5-20251001**. Other account-reported models remain
visible, with per-connection permissions; discovery is not live qualification.

| Gate                                                                                                 | Evidence                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real embeddings, scoped persistent vector retrieval, PDF/Markdown/email inputs and citation IDs      | [Actual model/document checks](validation/local-retrieval-2026-09-29.md), [final four-client searches](../release/0.2.0-rc.1/retrieval-client-verification.json)         |
| Dedicated Linux account containers, native execution, cancellation and recovery                      | [Boundary review](validation/account-isolation-2026-09-29.md), [final-image lifecycle](../release/0.2.0-rc.1/account-container-verification.json)                        |
| Execution, pairing, retrieval, credential and tool boundaries                                        | [Actual Linux checks](validation/security-real-2026-09-29.md), [unchanged enforcement code](../release/0.2.0-rc.1/security-code-identity.json)                           |
| Three app-owned workflows, persistence, explicit selection and cancellation/recovery on the final RC | [Immutable consumer receipts and CI](../release/0.2.0-rc.1/consumer-acceptance.json), [host terminal reconciliation](../release/0.2.0-rc.1/app-host-reconciliation.json) |
| Fresh installation, preserved host/desktop state, local/remote pairing and SSH recovery              | [Packaged desktop and user-local installation](../release/0.2.0-rc.1/desktop-verification.json)                                                                          |
| Exact-source Prometheus builds, fresh language installs, hashes and provenance                       | [CI/publication](../release/0.2.0-rc.1/ci-publication.json), [registry verification](../release/0.2.0-rc.1/registry-publication.json)                                    |
| Publication and public downloads                                                                     | [GitHub verification](../release/0.2.0-rc.1/github-publication.json), [release inventory](releases.md)                                                                   |

At the RC.1 gate, all three applications pinned `@agenticdriver/sdk@0.2.0-rc.1`
with registry integrity; the current pins are RC.2.
Brandstorm reviewed a selected-source answer; AI Workspace saved and edited a
reply draft; LitAgent accepted a supported writing proposal into a disposable
manuscript. Their own authentication, data and saved choices were preserved.
No private library/mailbox data or external email send was required. SDK-owned
retrieval acceptance does not automatically establish vector search inside an app.

The first candidate exposed a real Claude allowance limit and incorrect generic
error classification. [#75](https://github.com/agenticdriver/agenticdriver/issues/75)
corrected it to `RATE_LIMITED`; the same account/model succeeded after the
reported reset. [The original failures and recovery](validation/claude-limit-2026-09-29.md)
are preserved. No fallback account/model/billing, overage enablement or pre-reset
retry loop was used. Earlier candidate archives were superseded, not published
under the final artifact's identity.

## Limits retained for the candidate

- PyPI organization approval remains pending; reviewed Python wheel/sdist files
  are published on GitHub. No personal publisher is substituted.
- API billing routes, other native providers/models, macOS and Windows need
  separate live qualification. Account-container checks assume trusted host and
  Docker administrators; they are not a universal security certification.
- Native desktop boot was checked separately from interaction with its actual
  packaged renderer/worker through T3's private preview bridge. Complete native
  GUI and other-platform interaction is not claimed.
- Model output needs review. Unsupported checklist suggestions, an initially
  rejected literature question, a quote repair and advisory TeX formatting issues
  remain visible in the receipts. Citation membership does not establish factual
  truth or entailment. A supported draft is not automatically publication-ready.
- Expiring validation grants are not production application credentials. Use
  scoped host/desktop connection setup for ongoing applications. Usage UI readback
  does not establish automatic Usagestat ingestion or account binding.
- There is no default generation deadline, inactivity timeout, account/model
  fallback, public relay or automatic desktop updater. Capacity and long-duration
  production reliability remain workload-specific qualification.

The older [roadmap](roadmap.md) remains the historical planning baseline. Current
provider and publication follow-ups stay in the organization project; completing
this RC does not close unrelated provider or platform work.
