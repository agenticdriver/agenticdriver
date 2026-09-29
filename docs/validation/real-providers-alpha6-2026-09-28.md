# Real providers after removal of simulated connections

The alpha.6 candidate removes the built-in mock provider, fake embedding adapter,
offline provider definition, synthetic extension-conformance runner, seeded preview
connections/usage and the simulated provider acceptance harnesses. Its CLI requires
an explicit real provider before it writes a configuration or credential. A legacy
`kind: "mock"` configuration fails with `MOCK_PROVIDER_REMOVED`.

Six actual requests completed through a separate Prometheus candidate host reached
by a pinned OpenSSH tunnel. The existing regular application and validation hosts
were preserved. Exact run IDs, runtime versions, selected models and measured usage
are in the [machine-readable receipt](real-providers-alpha6-2026-09-28.json).

- Codex CLI 0.157.0, existing ChatGPT Pro account, `gpt-6-luna`, medium reasoning.
- Claude Code 2.1.282, existing Claude Pro account, `claude-haiku-4-5-20251001`.
- Each answered the real product brief, public-paper literature question and actual
  alpha.5 handoff draft in [the application prompts](../../examples/javascript/real-application-prompts.mjs).
- Catalog refresh during each run completed without cancelling generation.
- The host reports nine Codex and fourteen Claude models. Only the selected two
  were executed; discovery does not qualify all models.
- An actual authenticated remote attempt to add `kind: "mock"` received HTTP 400 /
  `INVALID_CONFIG`; the stored configuration revision remained unchanged.
- A fresh desktop profile showed zero connected instances and nine real connection
  kinds, with no offline choice. Ten saved SDK-owned preview configurations or
  fake connection records were cleaned; actual provider settings and app services
  were preserved.

All six outputs were reviewed. The Codex outputs preserved the supplied constraints.
Claude's literature answer added a qualifier about selection criteria unsupported
by the supplied notes, and its email phrasing was broader than necessary. Successful
transport is not an editorial or application acceptance pass.

TypeScript and the remaining 23 pure/process/validation tests passed, along with
three desktop security/packaging checks, eight CI-boundary checks, eleven release
archive checks, the documentation build and fresh npm artifact installation.
The simulated suites are removed, so these counts must not be presented as equivalent
to their previous coverage. Real RAG/embedding, native tools, container isolation,
other operating systems and complete consumer workflows require their own checks.

Private credentials, account identities and full receipts remain outside the
repository. Reported Claude dollar amounts are API-equivalent estimates, not
subscription invoice charges. Generation retains disabled-by-default timeouts and
there is no account/model/billing fallback.

The subsequently published [alpha.6 release](release-0.2.0-alpha.6.md) records
the exact final CI archive, two further real Codex/Claude requests, actual
management reads in all four languages, published downloads and desktop startup.
Its archive digest is separate from the source-candidate digest recorded above.
