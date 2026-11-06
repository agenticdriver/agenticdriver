# Source retirement qualification — 2026-11-06

This qualifies the [permanent source-retirement contract](../source-retirement.md),
not an application's semantic retrieval corpus or embedding quality. No model or
embedding execution, account changes, downloads of model weights or application
provisioning were performed.

## Storage and authorization

Actual SQLite checks cover late inserts and updates from independent connections
and another process, reopen, exact revision conflicts, capacity exhaustion,
duplicate reconciliation, cancellation and absent/altered persistent guards.
Service checks exercise the actual SDK HTTP route, separate token grants and
application-authorizer decisions. A production embedding adapter's refusing
credential resolver records zero calls.

Independent code review found a mixed-mode initialization race: a legacy opener
could overwrite the format number committed by a retirement opener. Initialization
now checks and publishes either format in the same write transaction. The new
barrier-controlled two-process regression fails with the transaction fix removed
and passes with it restored. Independently removing persistent guard enforcement
and final service reauthorization also made the corresponding regressions fail
before restoration.

The full SDK check passed **101 tests, one existing live Usagestat skip**, plus
typecheck and build. The **14** focused retirement/service/SQLite-lock tests also
passed on minimum Node **22.13.0**. Installed Python-wheel checks, mypy, Rust
**1.89** feature combinations and native tests, and Go race checks passed.
Protocol regeneration, formatting, diff and documentation-link checks passed.
Independent code and documentation findings were resolved.

## Four-language HTTP execution

An actual SDK loopback host with a fresh retirement-enabled SQLite file and no
generation providers accepted retirement requests from TypeScript, an installed
Python wheel (sync and asyncio), Go, and Rust (blocking and async). Each client
repeated its exact tuple successfully. After host restart, TypeScript reconciled
an earlier receipt. In total, **14** retirement requests passed; the production
embedding adapter recorded **zero** calls. These were storage mutations through
the real protocol, not provider substitutes or canned model results.

The initial private Rust qualifier used the wrong error annotation and did not
compile. Its annotation was corrected before its first requests; SDK code did not
change. The host restarted on the same database for that corrected qualification.

Private receipt:
`/var/tmp/agenticdriver-validation/retirement-wire-laz6fdo3/receipt.json`

SHA-256:
`01b35b98b105afda7e1c6f8ab26a0f3c69e495092fc5d7e4d424cdbd3b6db37f`

Logs are private alongside the retirement validation artifacts. The test host was
closed and its temporary bearer-token connection file removed. No existing
application host, corpus, grants or model selection was changed. Registry release
and downstream application adoption are separate work.
