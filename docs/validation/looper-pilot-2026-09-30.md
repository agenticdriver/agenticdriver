# Prometheus Looper pilot — 2026-09-30

The user-authorized first pilot is installed and running on Prometheus against
[Agent Orchestrator issue #26](https://github.com/hashimkarim/agent-orchestrator/issues/26).
It addresses the missing verified SDK declaration contracts behind
[AD-086 / #83](https://github.com/agenticdriver/agenticdriver/issues/83).
The existing four blocked RC.3 migration tasks retain their scopes, attempts and
failure history. This pilot changes coordinator source in an independent
worktree; it does not replace those tasks or establish app acceptance.

## Installed tools and real connection

- Looper upstream release: `v0.16.0`, source
  `2d1576ed1cce2604e56c6d11c5a128e90eb1d01c`. Published CLI and daemon archives
  were checked against both the GitHub release asset digests and their checksum
  files before installation.
- The user authorized package updates. Prometheus's global Codex installation
  was upgraded from `0.154.0` to current stable `0.159.2`. Existing account
  profiles and the previously qualified SDK sidecar runtimes were preserved.
- Metadata-only preflight confirmed the existing native ChatGPT Pro session,
  ten reported models, and `gpt-6-luna` with medium reasoning. No alternative
  account, model or API billing mode was selected.
- The actual coding worker's native execution header confirms `gpt-6-luna`,
  medium reasoning, OpenAI, and the independent Prometheus worktree. The worker
  completed package/context source edits and opened
  [draft PR #27](https://github.com/hashimkarim/agent-orchestrator/pull/27).
  This is real coding execution; it is
  not SDK generation or application acceptance. No provider-substitute run was
  used. The native CLI reported 91,000 total tokens for this coding run, without
  an input/output breakdown or billed cost. This is subscription usage, not a
  reported API charge.

The prompt is the complete issue body: collect the declaration entries actually
consumed from a SHA-256-verified package archive, include archive-local declaration
dependencies, remove silent truncation, and qualify the result against the
published SDK RC.3 archive. It explicitly preserves live services, credentials,
consumer task scopes and attempt budgets, and prohibits additional provider
inference. Pure package tests are permitted separately from model qualification.

## Timeouts and bounded work

Upstream `0.16.0` rejects zero agent timeouts and replaces them with role defaults
in its runners. The pilot uses the reproducible local build
`0.16.0-agenticdriver.1` with the
[disabled-timeout patch](looper/disabled-timeouts.patch). This patch permits zero,
preserves explicit zero through all four role constructors, and retains negative
value and duration-overflow validation. All legacy, inactivity and maximum-runtime
agent timeout fields are explicitly zero. Claim leases, shutdown handling and
network-operation timeouts retain their upstream behavior.

The daemon reports zero inactivity and maximum-runtime timeouts for every role.
Only one run can execute at a time, with two retry attempts. Planner, worker,
reviewer and fixer automatic discovery is disabled, coordinator dispatch is
disabled, and self-review and automatic merge are disabled. The only registered
project is the isolated Agent Orchestrator checkout. No repository-wide backlog
scan was enabled.

The initial focused task leaves packet-size packing and audited scope repair as
separate outstanding parts of SDK #83. All pilot commits must include `[skip ci]`;
the coordinator repository's current hosted workflow must not consume GitHub
runner minutes. The relevant inspected checks run directly on Prometheus.

## Persistent daemon and dashboard

The independent user service `agenticdriver-looper-pilot.service` is enabled and
active on Prometheus. User lingering is enabled so logout does not stop it. The
daemon listens only on `127.0.0.1:18766`. Native provider credentials stay on that
host. The dashboard does not use application authentication; access from this
computer uses the existing trusted SSH destination and a loopback-only tunnel.

The application computer's enabled user service
`agenticdriver-looper-pilot-tunnel.service` forwards `127.0.0.1:18765` to that
listener. Open [the local dashboard](http://127.0.0.1:18765/dashboard/).
The T3 collaborative browser loaded the production dashboard and observed
healthy service, scheduler and SQLite state with the registered project.

Operator commands use the installed pilot CLI:

```sh
ssh prometheus looper status
ssh prometheus looper ps
ssh prometheus looper describe 1
ssh prometheus systemctl --user status agenticdriver-looper-pilot.service
systemctl --user status agenticdriver-looper-pilot-tunnel.service
```

Loop sequence `1`, ID `222e17cf-9e63-48b3-8d89-b96f7632ed64`, owns issue #26.
Its first run, `run_51e8d9a1d9025b0bed861fdab7a6f836`, completed successfully
at `2026-09-30T19:39:46.819Z`. Source base is
`adf8e9e50b88efb0d677c45a4841193c6be9c798`. The daemon, config, worktrees and
private native logs live in Prometheus's user-owned `.looper` directory.
Private provisioning receipts remain outside source control.

## Observed setup checks

The patched source passed `go test ./internal/config`, `go vet ./...`,
`go build ./...`, and the production dashboard's frozen installation and build.
The focused config tests verify explicit disabled timeouts and rejection of
negative inactivity values; existing duration-overflow checks remain passing.
The full upstream agent suites were not run because they exercise provider
substitutes. The real worker independently establishes native execution, with
its code and package validation still subject to review.

Both service units are enabled and active. Configuration validation succeeds.
Actual `/api/v1/status`, `/api/v1/projects`, `/api/v1/loops` and `/api/v1/runs`
responses establish healthy state, the sole registered project, and the
completed worker with its draft PR. No synthetic provider, seeded account, invented
usage or mock model server was introduced.

| Installed pilot artifact | SHA-256 |
| --- | --- |
| CLI | `56b5245743eff3b2bd929ee8094951e93c3954091d1d92306db5e3afcec74456` |
| Daemon with production dashboard | `a2f49210469f84facf83b1cba3168bf2f9902f608934eca4c69cf1dd69324e17` |
| Local source patch | `70461c712196d99b5074f08e5dd0b54aba91c919e2a25c6a8bc2a1dec8e47b0d` |

## First result and independent review

The draft's published head is `f05c6a3b3b89c3c23ac31c1b11605fac1555d6ed`.
Codex's workspace sandbox prevented direct Git metadata writes. The worker
published from an independent temporary clone of the same task branch;
Looper subsequently created local fallback commit
`2a9687010d3215cba04cf456c3fc885a50d77a67` with identical file contents.
The primary agent fetched the actual PR head and verified that there is no
content difference before reviewing it. No native permissions, account or
billing mode were broadened to make publication work.

The primary agent independently reran `npm run typecheck`, `npm run build`,
and `npx --no-install tsx --test tests/packages.test.ts` on Prometheus against
those contents. All passed: eleven package tests, with two Bun-only skips.
The actual public SDK RC.3 archive was present and its qualification test ran.
All pilot commit messages contain `[skip ci]`, and the PR has no hosted check
run. These package checks establish code/package behavior, not app acceptance.

The actual five-entry declaration closure contains 48 files and 190,524 bytes.
The draft diagnoses that overflow explicitly before inference rather than
truncating it. Its 65,536-byte reference bound therefore still prevents a full
RC.3 contract packet. SDK #83 remains open.

Independent review reproduced failures for ordinary manifests without export
maps, `.mjs` declaration dependencies, imports in comments, and ignored absolute
reference paths. It also identified silently skipped missing scoped consumer
files. The initial manual fixer skipped the general review body because it had
no actionable inline findings. The primary agent then posted five inline review
threads; loop sequence `3`, ID `d0ba75c8-b72a-4085-a2b9-a6543d588618`, now runs
the bounded repair on the same PR. Run `run_fdaea0e53cd1869dafeafb7e868659cd`
is in its real repair step. Fixer draft support is enabled for this selected
pass; automatic discovery, self-review and automatic merging remain disabled.
No merge, consumer retry, task-scope change or rollout completion is claimed.
