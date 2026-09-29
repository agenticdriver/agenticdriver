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
claim successful generation while the account is limited. Final successful
Claude and consumer acceptance remain part of the RC gate after recovery.
