# AgenticDriver project instructions

## Use real connections and real example prompts

- Use real provider connections and the actual connected accounts when developing, demonstrating and validating functionality.
- Do not add or run mock providers, mock model servers, canned model responses or synthetic provider substitutes. Mock-only checks are not evidence that a feature works.
- Use meaningful, realistic example prompts for the applications this SDK serves: brand brainstorming from a concrete brief, literature questions grounded in actual public papers or documents, and email summaries or reply drafts from realistic example threads. A trivial “say hello” prompt is not sufficient application validation.
- Use an inexpensive model for each provider being tested. Keep the provider, account, exact model and billing mode explicit; preserve existing selections and never silently fall back to a different connection.
- If a real connection is unavailable, incompatible or unauthorized, fix or report that actual blocker. Do not replace it with a mock or mark the feature complete on simulated evidence.
- Record the actual provider/CLI version, selected model, connection path, example prompt, observed result and reported usage where available. Distinguish a connection check, successful model execution and application acceptance.
- Keep credentials in the existing private credential files or stores. Use public material or realistic example content for prompts unless use of private application data is explicitly authorized.
- Preserve historical fixture results as historical evidence; they do not replace the required real-connection checks for current work.

## Remote validation on Prometheus

- Prometheus is authorized as a remote test execution host using its existing Codex and Claude native sign-ins. Verify the current sign-in and model catalog before using a connection.
- Use the existing trusted `prometheus` SSH destination and a separate loopback test host. Preserve application services, shared CI workers and native account profiles; keep provider credentials on the execution host.
- Prefer the established inexpensive selections, Codex `gpt-6-luna` with medium reasoning and Claude `claude-haiku-4-5-20251001`, when those accounts report them. A missing model or failed account is a blocker to diagnose, not permission to switch accounts, models or billing modes.
- Read `docs/real-connections.md` and `docs/validation/prometheus-real-2026-09-28.md` for the supported route and the limits of the recorded evidence. Private provisioning details are in the local validation state, not source control.
