# Real Linux account isolation — 2026-09-29

Issue [#68](https://github.com/agenticdriver/agenticdriver/issues/68), RC prerequisite
[#71](https://github.com/agenticdriver/agenticdriver/issues/71).

The account recipe ran in Prometheus's existing SDK-only Docker-in-Docker engine.
Two private disposable account volumes were explicitly provisioned with the
authorized Codex and Claude native sign-ins. Their original host directories,
regular app services, selected billing routes and CI workers were preserved.
No mock provider or model endpoint was involved.

Codex 0.157.0 / gpt-6-luna / medium and Claude Code 2.1.282 /
claude-haiku-4-5-20251001 each completed the meaningful release-handoff prompt
in deploy/account/qualify.mjs, then a separate request was cancelled after real
model progress. The private receipts contain the actual text for review. The
[redacted record](account-isolation-2026-09-29.json) retains run IDs, measured
usage, response hashes, observed runtime/catalog metadata and container digests.
No completed usage is inferred for interrupted requests.

Observed boundaries:

- Non-root UID 1000, read-only runtime, no capabilities, no-new-privileges,
  seccomp and configured memory/PID bounds were effective.
- Account volumes and PID namespaces were distinct; the sibling native sign-in,
  host home and Docker socket were absent. The other account's bearer was rejected.
- SDK cancellation removed invocation directories. A follow-up probe found no
  remaining Codex or Claude native process.
- Stopping the selected container removed a deliberately detached process and
  temporary marker. Persistent account state and real catalog access recovered
  after restart, while the sibling account remained running.

Two qualification-script issues were corrected without provider fallback: copied
account directories needed UID 1000 ownership, and PID namespace inode numbers
can be reused after shutdown, so lifecycle checks inspect the actual escaped
process and filesystem state instead. The initial invalid example token lacked
a required ID; the documented example now passes the actual HostConfig schema.
The source Dockerfile also needed to copy clean-dist.mjs for alpha.6 builds; that
build omission is fixed and real image construction is added to Prometheus CI.

This verifies the Linux account boundary with a trusted host operator and shared
kernel. It is not hostile-kernel escape resistance, mutually untrusted tools
inside one account, an independent security audit, or macOS/Windows support.
The cross-platform AD-012 parent and integrated #35 review remain separate work.
Final RC images must be checked again when their runtime changes.

## Exact-source CI

Commit `5e7589290bad4806367f0f00eb995c540d400107` passed all seven jobs in
[Prometheus run 36558265945, attempt 2](https://github.com/agenticdriver/agenticdriver/actions/runs/36558265945):
Linux desktop, three client/runtime matrices, actual account-image builds,
documentation, and exact release-artifact installation. The first attempt
stopped at the disk-space guard before source verification. Removing unused
SDK-owned audit images and the retired SDK fixture deployment recovered space;
application hosts and other projects' CI services were preserved. CI contains
no native account credentials and performs no model requests; the real account
results above remain separate evidence.
