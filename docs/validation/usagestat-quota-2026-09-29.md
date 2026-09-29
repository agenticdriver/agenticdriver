# Native Usagestat quota correction

Tracked by [#76](https://github.com/agenticdriver/agenticdriver/issues/76).
The Usagestat handoff identified that published SDK `0.2.0-rc.1` requests
`/v1/limits` and `/v1/limits/:instanceId`, neither of which the backend serves.
Desktop usage display already reads the correct native usage endpoints.

The focused source correction adapts prepared commit
`8bdacfd452c17109b96e8b56652153360e06daa0` from the separate
`agenticdriver-usage-api` checkout. It preserves subsequent SDK changes and does
not modify the backend checkout or its active development branches.

Integrated source:
[`88daf7e52a956621389846e997a275ad97f9ae4a`](https://github.com/agenticdriver/agenticdriver/commit/88daf7e52a956621389846e997a275ad97f9ae4a).
All seven checks passed in
[Prometheus run 36594840281](https://github.com/agenticdriver/agenticdriver/actions/runs/36594840281):
desktop, minimum runtimes, current language clients, current Node, account
deployment, documentation and exact package installation. Local typecheck,
unit/process checks and build also passed. The live account test described below
was run explicitly; it is skipped by CI without an explicitly configured daemon
and private account bindings. CI success does not substitute for that live check.

## Behavior

`limits()` derives quota resources from `GET /v1/usage`; `accountLimits()` reads
only the explicitly bound `GET /v1/usage/:instanceId`. The derived document uses
`agenticdriver.usagestat-limits.v1`. It is a client-side document, not a new
backend route. Consumers validating the old `crossusage.limits.v1` literal must
update with the next SDK package.

Original timestamps, source, labels, units and reset windows remain visible.
Malformed progress data is omitted, not converted into allowance. Failed states
remain unavailable even if the backend retained progress metrics. Identity
binding, freshness and allow/reject-unknown policies remain explicit; neither
provider-family fallback nor production account mappings are introduced.

## Actual running daemon

The existing loopback daemon at `127.0.0.1:6736` was read without restarting it,
changing its profile or triggering model requests. It reported `2.0.0-alpha.4`
but was running a development executable, SHA-256
`873049d76470c72d6ac6cfed98273452a545b560d9aa84ed46d30dc38e2ffb6a`.
Its source revision cannot be established from that version string. It is not
represented as the published binary.

The opt-in `tests/usagestat-quota.test.ts` check at **15:56:41 UTC** used explicit
administrative validation bindings for the five instances actually returned by
the daemon. The host/subject identify this local read check; these in-memory
mappings do not provision or certify an application execution-account binding.
Every HTTP response was the actual daemon response. No provider observations,
connections or model replies were fabricated.

| Check                       | Observed result                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Administrative native read  | Five real snapshots; legacy limits route returned 404                                  |
| Scoped quota                | Two usable accounts, three unavailable accounts                                        |
| Retained failed snapshot    | One failed cached snapshot with progress metrics correctly rejected                    |
| Derived values              | Three reported resources retained their amounts, units and reset timestamps            |
| Admission                   | Two allowed observations; two above-cap thresholds rejected; four unknown observations |
| Missing subject grant       | All five instances rejected before HTTP, including allow-unknown policy                |
| HTTP reads in live test     | 14                                                                                     |
| Model calls / usage capture | None                                                                                   |

Raw snapshots, identity mappings and local receipts remain in private validation
state. No credential or account label is committed. The test's one-hour freshness
bound is an explicit check configuration, not a new SDK default or a promise
about the backend's polling interval.

## Published backend compatibility

Separately downloaded the actual
[Usagestat `v2.0.0-alpha.4` Linux x64 archive](https://github.com/hashimkarim/usagestat/releases/tag/v2.0.0-alpha.4)
and verified its public asset digest:

- Archive: `b8c064fa4002e5bef1de88e3da90d6e1b4c34bfcae029cd9e45a220667cfe2cc`
- Daemon: `7e7833a1168f1f802983721e87589a701d40e454aeba915ddd46afb2636136ba`

The published daemon does **not** support the development `--no-poll` flag.
The desktop native check was corrected to copy the actual executable into an
isolated temporary profile, with no provider plugins discoverable from either
its executable or working directory. This serves real empty native responses and
does not poll accounts. Configuration/data directories and the existing service
remain untouched.

At **16:01:05 UTC**, this exact published binary passed native provider/usage
readback and the corrected empty `limits()` call. The legacy route still returned 404. The desktop controller's native read integration also passed. This verifies
the released empty read contract separately from the running development daemon's
live-account evidence; it does not claim live-account qualification of the
published backend or SDK run ingestion.

## Release boundary

The shared provider-icons pin remains `v0.1.0-alpha.1`. Usagestat alpha.4 remains
the released native-read dependency. AD-030 ingestion is development-only at
`e3330d6f454d6b67f6b58247aeff78e84c3873d0` and requires its own release,
`usagestat.run-ingestion.v1` handshake, exact account binding and real execution/
embedding reconciliation. This quota correction does not qualify that ingestion
path or alter native quota/history accounting.

The published AgenticDriver RC.1 retains its quota defect. Source integration is
not a package release; the changelog and RC.1 qualification page explicitly record
that a subsequent SDK package is required. Existing app pins and running hosts
have not been silently upgraded.
