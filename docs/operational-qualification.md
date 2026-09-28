# Operational qualification

A production workload must be qualified against its actual provider accounts,
transport and deployment. There is no simulated provider or offline soak runner
in the current SDK. Historical soak receipts do not establish real account limits,
provider reliability, production capacity or billing behavior.

Start with the [real connection checks](real-connections.md). Record the selected
account/model, CLI version, concurrency, request count, actual responses and usage.
Use a bounded number of useful requests rather than an unbounded paid stress loop.
Check cancellation, active-run protection and connection revocation on the selected
host without changing other applications' grants or interrupting their work.

Generation has no default total deadline or inactivity timeout. Applications may
set an inactivity timeout that resets on actual model or tool progress. Catalog,
credential and shutdown operations have separate bounded control-plane lifetimes.

[Prometheus evidence](validation/prometheus-real-2026-09-28.md) covers real text
requests, catalog refresh during execution, pairing/revocation and remote settings.
It does not qualify container isolation, RAG/embedding accounts, all catalog models,
all operating systems or complete consumer application workflows.
