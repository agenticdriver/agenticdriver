# Real Prometheus validation — 2026-09-28

Nine SDK runs completed against real native subscription accounts on the
user-authorized Prometheus host. Every request travelled from a separately
installed client on the application computer, through verified OpenSSH, to a
loopback AgenticDriver host on Prometheus. No mock provider, replacement model
server or canned response was used.

The host and JavaScript client used published `@agenticdriver/sdk@0.2.0-alpha.5`.
Python used the checksum-verified `0.2.0a5` GitHub wheel in a fresh environment;
PyPI organization approval remains pending. Go installed `v0.2.0-alpha.5` through
the ordinary module proxy without a `replace` directive. Rust installed the
exact `0.2.0-alpha.5` crate from crates.io in a fresh application.

## Host and explicit selections

- Prometheus: Fedora Linux x64, kernel `7.0.12-201.fc44.x86_64`, Node `24.16.0`.
- Codex: qualified CLI `0.157.0`, `gpt-6-luna`, medium reasoning, existing ChatGPT
  Pro native session.
- Claude: qualified CLI `2.1.282`, `claude-haiku-4-5-20251001`, existing Claude Pro
  native session.
- The qualified runtimes were installed in a separate user-owned directory and
  checked against their previously recorded SHA-256 digests. The normal Codex
  `0.154.0` and Claude `2.1.268` installations were not replaced.
- The separate host bound only `127.0.0.1:17435`. The application-side SSH tunnel
  also bound only loopback. Existing native sign-in stores stayed on Prometheus;
  CI containers received no account credentials.
- The configuration imposed no model allowlist override. Only the two exact
  models above were run. Latest refresh reported nine Codex entries and fourteen
  Claude entries. The first Claude inspection reported eight entries; later
  inspections returned fourteen. Those catalogs remain reported metadata, not
  live qualification of every entry.

## Actual application prompts and results

The [prompt source](../../examples/javascript/real-application-prompts.mjs) contains
the complete inputs. Brandstorm prompts use AgenticDriver's product brief.
Literature prompts use short, attributed notes from
[Lewis et al.](https://arxiv.org/abs/2005.11401v4) and
[Liu et al.](https://arxiv.org/abs/2307.03172v3). Workspace prompts ask for an email
draft from the actual alpha.5 release handoff. No email was sent and no private
mailbox, manuscript or library was accessed.

| Client     | Provider/model                       | Cases                             | Completed runs |
| ---------- | ------------------------------------ | --------------------------------- | -------------: |
| JavaScript | Codex / `gpt-6-luna`                 | Brandstorm, literature, workspace |              3 |
| JavaScript | Claude / `claude-haiku-4-5-20251001` | Brandstorm, literature, workspace |              3 |
| Python     | Codex / `gpt-6-luna`                 | Literature                        |              1 |
| Go         | Claude / `claude-haiku-4-5-20251001` | Workspace                         |              1 |
| Rust       | Codex / `gpt-6-luna`                 | Brandstorm                        |              1 |

The actual answers were reviewed. The brand results gave distinct directions,
taglines, colour pairs and audience rationales. Literature answers cited both
supplied papers and distinguished reported findings from proposed experiments.
Email drafts retained pending PyPI approval and did not claim confirmed app
adoption. Claude's JavaScript email draft blurred discovery and execution in one
action item, despite distinguishing them in its closing note; it needs editorial
review. Model completion is not a guarantee of factual or editorial quality.

Codex advertised `textStreaming: false` and delivered final text in one delta
per run. The three JavaScript Claude runs delivered 79, 103 and 42 text deltas.
Metadata was refreshed after each of those runs started, and all three completed
without cancellation. SDK retries were limited to one attempt. No generation
deadline or inactivity timeout was set.

## Connection and settings checks

The real host accepted one-use invitations for separate execution and management
profiles. Execution access covered only the two selected instances. Management
had no execution grants. A further short-lived connection proved one-provider
scoping, rejection of an already-consumed invitation (`INVITATION_REJECTED`) and
rejection of requests after revocation (`UNAUTHORIZED`). That grant was revoked.

The execution profile could not call provider management (`FORBIDDEN`). Through
the management profile, a Codex display-name edit persisted and read back, a
stale revision was rejected (`CONFIG_CONFLICT`), and the original name was restored.
No account identity, native path or model policy was changed by that edit.
Both provider catalogs refreshed successfully over the SSH route.

## Reported usage and evidence

| Provider | Runs | Input tokens | Output tokens | API-equivalent estimate |
| -------- | ---: | -----------: | ------------: | ----------------------: |
| Codex    |    5 |       30,865 |         1,147 |            Not reported |
| Claude   |    4 |       15,298 |         5,417 |               $0.042383 |

These are native CLI reports, including native runtime overhead. Claude's
API-equivalent estimate is not an actual subscription charge. Neither adapter
reported an actual billed cost. The host's existing JSONL usage sink recorded
all nine completed runs; this separate host does not yet forward usage to the
shared Usagestat ingestion service.

The [machine-readable receipt](prometheus-real-2026-09-28.json) records each run ID,
timing, selection, usage and response checksum, plus checksums of private full
receipts. Full responses, prompts and private connection profiles are retained
under the local validation state with restrictive permissions. Public evidence
omits email/name, token values and native account identifiers. JavaScript syntax,
Go/Rust compilation and the documentation build are checked separately. Legacy
mock-based suites are not claimed as validation of this work and were not rerun.

## Scope and reuse

The remote host is `agenticdriver-remote-testing.service` in Prometheus's user
systemd. It can be started explicitly with
`ssh prometheus systemctl --user start agenticdriver-remote-testing.service`.
The application computer's current tunnel is the transient
`agenticdriver-prometheus-test-tunnel.service`; use the
[SSH recipe](../real-connections.md) when creating a new route. Neither unit was
enabled for automatic startup.

The test execution connection has a six-hour lifetime; the management connection
has one hour. Issue a new scoped invitation for later work or for another app;
do not reuse a validation credential as a production app grant. The host's
separate static operator credential stays private on Prometheus.

This evidence covers the selected accounts, runtimes, models and SSH route at the
recorded time. It does not qualify other models, API accounts, verified HTTPS,
container account isolation, PDF extraction, vector retrieval or any consumer's
complete UI/workflow. The literature input is supplied context, not a vector
search. App-owned end-to-end checks and Linux account-container qualification
remain separate tasks.
