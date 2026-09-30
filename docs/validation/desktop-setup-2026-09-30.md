# Desktop setup overview — 2026-09-30

The new Overview screen guides setup of an execution host, provider accounts,
application grants and optional Usagestat readback. Tracking:
[#78](https://github.com/agenticdriver/agenticdriver/issues/78).
This is post-RC.2 source work; the existing published RC.2 archives are unchanged.

## Real connection checks

An independent empty desktop profile started its actual SDK host, with zero
provider connections and zero application grants. Its configured local Usagestat
2.0.0 read service returned six existing snapshots. These are backend observations,
not seeded desktop data or new account bindings.

A separate management-only invitation connected that desktop to the existing
Prometheus RC.2 validation host through verified OpenSSH and loopback. Metadata
refresh reported the selected native Codex 0.157.0 and Claude Code 2.1.282 accounts
signed in, with nine and fourteen account-reported models respectively. The summary
omits identity fields, credential references and native runtime paths. Grant and
in-flight request counts come from the actual host's connection list; they include
metadata requests and are not persistent presence or model-execution counts.

Additional real grants/checks verified:

- A one-provider connection without management access saw only Codex and its nine
  reported models; application-grant inspection was unavailable.
- Revoking the exchanged management connection produced access rejection, with
  provider and grant observations unavailable. Local Usagestat readback remained
  available independently.
- Reconnecting through a fresh invitation preserved the saved host identity and
  label and restored management metadata. Previous grants were not silently widened.
- Stopping the empty desktop-owned local host showed its stopped recovery state
  while Usagestat remained readable. Starting it restored the saved endpoint.
- The management-only credential rejected a model request before execution.

No production application services, existing provider configurations or native
account profiles were changed. Temporary setup-test grants are separate from
normal application access and are revoked after qualification.

## Real generation during setup refresh

The existing explicitly selected Codex subscription connection ran the public
[AgenticDriver brand brief](../../examples/javascript/real-application-prompts.mjs)
with `gpt-6-luna`, medium reasoning, one attempt and one step. No generation deadline
or inactivity timeout was set. Setup metadata refreshed after `run.started`; the
same run completed, with provider configuration unchanged.

Run `e431d866-f630-44b4-98aa-5883f0034970` reported 6,129 input tokens, 264 output
tokens and 4,864 cached input tokens; reported reasoning tokens were zero. It
returned three reviewed brand directions with taglines, colours, motifs and
audience rationales. No billed charge was reported. Claude was inspected for
metadata only; this check does not qualify other models or API billing routes.

Released Usagestat 2.0.0 had already captured the actual host's usage record before
its first scoped reconciliation read. The record's usage matched and delivery was
`local`; no manual capture, replay or model rerun was used.

## UI and build checks

T3's collaborative browser inspected the actual desktop renderer/controller at
1920×1080 and 390×844. The empty and connected overviews showed their real counts,
all five navigation controls fit the narrow layout, and no horizontal document
overflow was observed. Provider, application connection and home navigation used
the existing controls with the selected host retained. The connected application
form exposed the two actual provider choices. This is renderer/controller QA;
complete native-window interaction is not claimed by the browser check.

Seven desktop tests passed, including pure IPC request validation, summary privacy,
unknown/completeness semantics and packaging boundaries. SDK build, JavaScript
syntax, documentation build and whitespace checks passed separately. These pure
checks do not substitute for the real connection and generation evidence above.
Prometheus CI and packaged-artifact checks are recorded after their completion.

Private invitations, connection profiles, native account metadata and full model
receipts remain under the local validation state. No credential values or identity
fields are published here.
