# Synthetic operational qualification

The count-driven soak checks an authenticated loopback HTTP host under repeated
concurrent streaming, queue saturation and explicit cancellation. It uses only a
synthetic provider with zero billable calls. Run it from a source checkout:

```sh
npm ci
node --expose-gc --import tsx scripts/operational-soak.ts \
  --cycles 100 --output /tmp/agenticdriver-operational.json
```

Use a current maintained Node LTS runtime and record its patch version. The local
Linux x64 development run on **Node 24.21.0** passed 100 measured cycles plus
warmup: 35,496 completed streams, 1,224 cancellations, 102 rejections, no retained
heap growth above warmup and at most 29.32 MiB RSS growth. It exercised the
development harness, not a clean committed CI artifact; the issue and workflow
receipts track subsequent exact-source qualification.

The same workload on the machine's older **Node 26.0.0** showed approximately
10.20 MiB retained heap growth after 100 cycles. Heap inspection found growing
weak-reference bookkeeping. A standalone observed-composite cancellation probe
retained 10,000 dependants on 26.0.0 and none on 24.21.0; this is consistent with
Node's [reported signal-retention problems](https://github.com/nodejs/node/issues/64476)
and [upstream fix](https://github.com/nodejs/node/pull/64481), not proof that this
particular soak has the identical cause. The initial 32 MiB gate was too permissive to reject that finite trend. The
current gate is tightened to 8 MiB; the old runtime's observed growth exceeds it.
It is not the operational baseline. Minimum API compatibility is separate from
operational qualification of a maintained runtime patch.

Choose a new output path; existing reports and symlinks are refused before work
starts. The JSON receipt records the exact source and whether it was dirty, Node
version, OS/architecture, workload, thresholds, counters and memory checkpoints.
It contains no prompts, results, token values or account identities. All fixture
credentials are generated in memory and scoped to the loopback mock host. No
provider setup, shared service or application configuration is read or changed.

The separate **Synthetic operational qualification** Actions workflow runs the
same check on Prometheus from `sdk-roadmap`. Its default is 100 cycles; the local
command defaults to 20. This is an explicit operational check, separate from the
nine release-build checks. The workflow uses no registry/provider credentials or
GitHub-hosted compute. Failed receipts remain failed and the job exits nonzero.

## Workload and pass criteria

Two warmup cycles precede the measured cycles. Each cycle:

- Fills eight active slots, one per authenticated subject, then fills all 32
  queue positions and verifies a typed, retryable `QUEUE_FULL` rejection.
- Explicitly cancels eight queued streams and four running streams. Replacement
  requests must gain the freed capacity. The remaining 28 held requests complete.
- Executes 20 batches of 16 concurrent streams. Each carries 16,384 input
  characters and produces exactly 8,192 visible output characters in 16 chunks.
  The fixture yields two milliseconds between chunks to exercise streaming and
  overlapping requests. `--batches 1..100` changes this fixed workload count.
- Checks per-subject identity and concurrency, ordered run events, one terminal
  result, exact final/streamed text, balanced provider starts/finishes and progress
  for every subject. After each batch, the scheduler, active provider work and
  diagnostic queues must be empty. Dropped diagnostics/export failures fail.

At default 20 batches, each cycle produces 348 completed streams, 12 explicit
cancellations and one capacity rejection. A 100-cycle run plus warmup therefore
checks 35,496 completions, 1,224 cancellations and 102 capacity rejections.

After warmup and each measured cycle, the harness requests V8 garbage collection
and records retained heap, RSS, external memory and array buffers. At every
checkpoint, retained heap growth must stay within **8 MiB** and RSS growth within
**256 MiB** of the warmup checkpoint. These are regression gates for this exact
workload, not production capacity recommendations. Receipts preserve all samples
so trends remain inspectable even when a gate passes. A failure does not silently
raise the threshold or rerun a shorter workload.

The workload terminates by count. Fixture-state watchdogs, the 20-minute harness
watchdog and Actions' job limit detect broken tests; they are never passed as SDK
run or inactivity settings. The production defaults remain disabled. Host and
diagnostic cleanup run on success or failure; unfinished requests are cancelled.

## Limits of this evidence

Both the clients and host occupy one process, so its memory measurement includes
the fixture and HTTP client pools. Synthetic chunk pacing does not model real
provider latency, tokenization, quotas, cost or account concurrency limits. This
does not qualify native process isolation, hostile plugins, production traffic,
an OS other than the receipt's OS, or application acceptance.

This soak verifies recovery after cancellation and saturation in the same host.
It does not restart that process. The separate [durable-job tests](../tests/jobs.test.ts)
exercise actual worker crash, lease fencing and preservation of completed effects;
see [durable jobs](jobs.md) and [idempotency](idempotency.md). AD-044 remains open
for real application/provider workloads and the full v1 support commitment.
