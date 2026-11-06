# Local Antigravity execution — 2026-11-06

The locally installed `agy` successfully completed one real, self-contained brand
brainstorm using the existing native profile and explicit
**gemini-3.8-flash-low** selection. The current native catalog contained that
exact model before execution. No API credential, alternate account or fallback
model was supplied. The account plan and actual billing charge were not reported.
This was a direct native CLI run, not an AgenticDriver adapter run.

## Runtime and request

The initial version command reported **1.4.4**. After the model run, the same
installed path reported **1.5.1**. The executable hash recorded immediately
before launching the model process matched the post-run executable:
`72738cf0445918483956a5f0da33abdfcfb21a12dd9a421fd57d063782826669`.
No explicit update command was run. The initial version label must not be used
as proof of the version that executed inference.

The CLI ran in a fresh private empty workspace with `--sandbox`, `--mode plan`,
`--disable-slash-commands`, `--print-timeout 0` and streaming JSON output.
Its actual initialization reported the exact selected model, 60 advertised tools
and `request-review` permissions. These are native controls, not the SDK's
restricted text-adapter contract.

The exact public prompt was:

> Use only this supplied brief. Do not use tools, read files, browse, delegate, or edit anything. Propose three distinct brand names with one tagline and a short positioning sentence each for an 18L repairable commuter backpack for Amsterdam cyclists aged 25–40. It has recycled fabric of unverified composition, replaceable buckles and a laptop compartment; target price EUR120–160. Avoid waterproof, carbon-neutral, certification or trademark-availability claims. Retain the capacity, city, audience, price and repairability constraints in a short final note. Keep the answer under 220 words.

## Observed result

One user turn completed successfully in 7.36 seconds. The answer proposed
**Grachtwerk**, **Traptrede** and **Klinkers**, each with a tagline and positioning.
Review confirmed it retained the 18L capacity, Amsterdam audience, repairability,
laptop compartment, recycled-fabric uncertainty and €120–160 target. It avoided
the prohibited performance/certification claims. Names remain creative proposals
without trademark clearance.

Reported usage was **7,960 input / 224 output / 0 thinking / 0 cache-read tokens**,
8,184 total. The stream contained only `user_input` and `agent_response` steps;
no tool invocation was observed. The workspace remained empty. The CLI exited 0.
There was no retry. Native conversation persistence remains owned by the CLI.

## SDK boundary remains separate

After execution, the production no-prompt readiness checker tested this same
installed binary with its isolated empty-tool custom agent. It reported version
**1.5.1**, exact model/agent, strict permissions and **60 tools**;
`status: unsupported-tools`, with no prompt submitted by that probe.
The successful native answer establishes that local `agy` and its selected model
work. It does not establish enforcement of an empty native tool inventory or
application-tool approvals through an SDK adapter. See the
[readiness contract](antigravity-2026-09-21.md).

Private artifacts were written on a filesystem enforcing private permissions.
The dispatch intent was persisted before launch; events were appended and synced
as they arrived. Sanitized summary SHA-256:
`cfe17ff7d5a4d43f3d84528b7f7d4618b0a51052f4bc3924eccb52836c86d228`.
Raw event SHA-256:
`0acf4101ce2ea868f1213825262ae66c77b2f7824a6190536f2d8386338311f7`.
