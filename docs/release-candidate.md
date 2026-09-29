# Release candidate gate

Tracking: [#71](https://github.com/agenticdriver/agenticdriver/issues/71).
Target: **0.2.0-rc.1** (Python **0.2.0rc1**). Not yet qualified or published.

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

## Current baseline

- Brandstorm: registry alpha.6, mounted Quickstorm, three persisted proposals,
  explicit Codex/Luna; source 0920c543a2b375d47f897fa7124f1c812745ce81.
- LitAgent: registry alpha.6, actual public-abstract Q&A/writing and support
  review through Claude/Haiku; full-PDF retrieval and workflow recovery pending.
- AI Workspace: registry alpha.6, actual adapter triage through Codex/Luna;
  generation in the mail UI and accepted-draft flow remain application work.

The three existing app threads own their consumer changes and report immutable
commits, selected account/model, run IDs/usage, UI checks and Prometheus receipts.
The SDK thread owns provider execution, retrieval adapters, host controls and
release artifacts. Private credentials never enter source control or handoffs.
