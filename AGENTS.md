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
