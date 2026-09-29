# Actual Claude subscription-limit handling

During RC acceptance, Prometheus's existing Claude Pro account remained signed
in and reported fourteen models, but the selected
`claude-haiku-4-5-20251001` could not run. Claude Code `2.1.282` reported a
rejected five-hour allowance and rejected overage. This is an execution limit,
not a missing sign-in or an unavailable catalog.

The Python candidate's brand-brief request
`27601e3d-08e8-4f30-b5ed-5447bda41495` failed with the old generic `CLI_FAILED`.
A separate native diagnostic, using a public release-review prompt with the
same tool restrictions and account/model, returned a structured
`rate_limit_event`, `assistant.error: rate_limit` and an error result. Its reset
was reported as `2026-09-29T15:10:00Z`. No overage, API billing or account/model
fallback was enabled. The failed request's usage remains unknown, not zero.

After the [#75](https://github.com/agenticdriver/agenticdriver/issues/75) change,
an actual SDK request through that same native account returned `RATE_LIMITED`:
run `5665158d-889c-4897-8583-9a837bcf9ef6`. The prompt asked for a concise research
application release-review checklist covering citation accuracy, saved settings,
explicit account/model selection, cancellation and recovery. There was one
`run.started`, one `step.started`, one `run.failed`, no text delta and no completed
run. The explicit retry policy allowed one attempt. The public error contains
fixed actionable text; native diagnostic bodies, identity and reset-time details
are not copied into it. Provider credentials stayed on Prometheus.

Parser checks cover these observed protocol diagnostics and distinguish ordinary
assistant text, nonterminal warnings and unknown failures. They substitute no
provider or model. This receipt validates the real failure path; it does not
claim successful generation while the account is limited. The post-reset check
below separately establishes successful generation; consumer acceptance remains
an independent RC gate.

## Observed recovery

After the reported reset, metadata was refreshed at `2026-09-29T15:11:01Z`.
The same account identity, Pro subscription, CLI version and selected Haiku
model were confirmed. One deliberately scheduled request through the installed
Python RC client completed: `b9fa7219-8d60-4c09-8d48-d605dda33b86`.
The concrete AgenticDriver brief produced three useful brand directions, each
with a tagline, two hex colours and a visual motif, in 171 words.
This is creative proposal material, not a guarantee of the suggested capabilities.

Reported usage was 3,750 input / 967 output / 0 cached tokens, with API-equivalent
cost $0.008585, not a subscription charge. There was no account/model/billing
change or automatic retry. The original failures remain preserved. Successful
generation after recovery and application acceptance are separate checks; the
[RC record](release-0.2.0-rc.1.md) tracks the latter.
