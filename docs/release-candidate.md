# Release candidate gate

Tracking: [#71](https://github.com/agenticdriver/agenticdriver/issues/71).
Target: **0.2.0-rc.1** (Python **0.2.0rc1**). Candidate artifacts are being prepared;
final artifact acceptance and publication are pending.

The first final-artifact check exposed an actual Claude subscription limit. Its
generic error is corrected in [#75](https://github.com/agenticdriver/agenticdriver/issues/75),
with [real failure-path evidence](validation/claude-limit-2026-09-29.md). The
earlier `d2d91ad` candidate is superseded. Successful Claude execution and final
consumer acceptance await the selected account's reported allowance reset;
no account, model or billing fallback is inferred.

The candidate targets the Linux x64 host and desktop, all four language clients,
and explicitly selected Codex/Claude subscription accounts through local or
secured remote connections. Catalogs still expose all account-reported models;
qualification applies only to exercised versions, routes and models. API adapters,
other native providers, macOS and Windows require separate live qualification.

## Required evidence

- Real embeddings and persistent vector retrieval of permitted PDF, Markdown and
  email sources, with selected-source authorization, revisions, deletion, restart
  persistence, citation validation and all four client contracts.
- Dedicated Linux account containers with real native execution and inspected
  account separation, cancellation, container shutdown and recovery (#68).
- Integrated execution, pairing, retrieval, tool and credential boundary review,
  with release-blocking findings fixed and residual assumptions recorded (#35).
- App-owned acceptance for Brandstorm, LitAgent and AI Workspace on the final
  artifact: mounted useful workflows, persistence, explicit selection, cancellation
  and recovery. Use public or realistic example content, never private user data
  or external side effects without separate authorization.
- Fresh host/desktop onboarding, pairing, upgrades and local/remote recovery.
- Exact-source Prometheus builds and release installs, hashes and provenance.
  npm uses trusted publication; Python uses reviewed GitHub archives until the
  selected PyPI organization is approved. Stable npm latest remains unchanged.

Alpha.6's real app receipts are the baseline. They do not validate later code.
Removed simulated tests and historical completion counts cannot satisfy these
gates. No default generation deadline, inactivity timeout or silent fallback is
introduced. Consumer applications keep their existing authentication.

## Completed development gates

- Real embeddings, scoped persistent retrieval and four-client contracts: [#72](https://github.com/agenticdriver/agenticdriver/issues/72),
  [actual model and document evidence](validation/local-retrieval-2026-09-29.md),
  all seven Prometheus checks passed on source `a8c53a6`.
- Linux account containers: [#68](https://github.com/agenticdriver/agenticdriver/issues/68),
  [actual isolation/cancellation/recovery evidence](validation/account-isolation-2026-09-29.md).
- Integrated Linux boundary review: [#35](https://github.com/agenticdriver/agenticdriver/issues/35),
  [real approval, pairing, adversarial content and replay evidence](validation/security-real-2026-09-29.md).

## Current consumer baseline

All three still use registry alpha.6. These receipts qualify their application
workflows; they must repeat relevant checks on the final immutable RC artifact.

| Application  | Actual workflow evidence                                                                                                              | Application source                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Brandstorm   | Quickstorm proposals, source-grounded question, saved answer/citations, disabled-selection rejection, cancellation and reload         | `cf56d05f7aca776569aeb536eb5745ee441cd3a7` |
| LitAgent     | Full public-paper context, Q&A, writing/support review, acceptance, cancellation/disconnect recovery and replay                       | App `docs/validation/driver-rc-consumer-2026-09-29.md`                              |
| AI Workspace | Mounted selected-message assessment, reviewable saved reply draft, edit/reload/repeated acceptance, cancellation and service recovery | `7823515ab5a927bfccf25d92ec56953cc91c941a`                                          |

The three existing app threads own their consumer changes and report immutable
commits, selected account/model, run IDs/usage, UI checks and Prometheus receipts.
The SDK thread owns provider execution, retrieval adapters, host controls and
release artifacts. Private credentials never enter source control or handoffs.
