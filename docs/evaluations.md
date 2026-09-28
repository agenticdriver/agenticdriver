# Application scenario evaluations

Run the SDK-owned synthetic suite from a source checkout:

```sh
npm ci
npm run evaluate -- --output /tmp/agenticdriver-evaluations.json
```

The output path must not already exist. Reports are created with mode `0600` on
POSIX systems. The file is reserved before any paid request; an interrupted or
failed invocation can leave it empty. Omit `--output` to print JSON. A zero exit status means the expected
fixture outcomes were observed, including rejection of deliberately bad outputs.
It does **not** mean a model or a production application passed a quality review.

The versioned [dataset](../evaluations/scenarios.json) contains fictional brand,
literature and email tasks. It has no customer documents, real findings or mail.
The suite records the dataset hash, SDK/source revision (or explicitly unknown),
dirty-source status, runtime, selected adapter/model and per-case results.
Source provenance belongs to the checkout running the suite, not an older SDK
release tag. CI uploads a report for each supported Linux Node version on
Prometheus. There are no model calls or provider credentials in fixture mode;
ambient provider-selection variables are ignored.

## What is scored

| Scenario     | Independent quality checks                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand brief  | Exact proposal count, distinct names, alphabet/length limits, required tagline word, forbidden words and selected colour palette.                                         |
| Literature   | Complete required facts, exact synthetic fact support, selected current passage IDs and quotations that both occur in the actual evidence and support the specific claim. |
| Email review | Exact review-only action set, selected thread, required label and draft text. Sending/deleting mail is never authorized or implemented.                                   |

These rubrics intentionally use small exact synthetic contracts. The literature
rubric is not a general semantic entailment evaluator; the brand rubric does not
measure creativity or trademark availability. The email rubric does not certify
a mailbox integration. Applications should add representative data and their own
quality criteria before treating model output as suitable for users.

Every scenario runs in-process and through an authenticated loopback HTTP host.
Evidence comes from a reopened SQLite vector index with deterministic lexical
embeddings. Positive cases receive only their selected source. Other-tenant and
unselected-source sentinel text must never reach the provider request.

Negative controls complete transport successfully but fail the quality rubric:
duplicate/forbidden names, wrong palettes/taglines, fabricated or stale citations,
a false claim with a real citation, wrong email threads, unauthorized send
proposals and altered draft text. Reports keep `transport`, `quality` and
`expected` separate. An expected quality failure counts as a **fixture control
passing**, not as a good answer.

Additional cases reject an unauthorized tenant/source, unsupported capability,
insufficient context budget, revoked evidence, stale index revision and deleted
evidence before generation. A hostile document's requested unselected tool is
rejected before an effect. Explicit cancellation occurs after a synthetic tool
starts and must reach that tool with no later effect. HTTP client cancellation
may surface as an aborted fetch; the report classifies it using the caller's
aborted signal, and separately waits for host-side tool cleanup.

HTTP here qualifies the SDK contract, not public ingress or TLS deployment.
Certificate and cross-language tests remain in the existing transport suite.
Real application adoption and selected-context workflows remain separately
tracked under AD-048 and the application threads.

## Optional live run

Live evaluation is never part of default tests or CI. It requires both an explicit
configuration file and `--allow-paid`. The configuration selects exactly one
supported API provider and model; the API key comes only from the named private
file. Existing native sign-ins, environment API keys, discovery defaults and
alternative billing routes are not used.

```json
{
  "provider": "openai",
  "model": "YOUR_EXPLICIT_MODEL_ID",
  "accountLabel": "selected-test-account",
  "providerVersion": "operator-recorded-api-version-or-date",
  "apiKeyFile": "/private/path/to/provider-api-key"
}
```

Supported API provider values are `openai`, `anthropic`, `gemini` and `xai`
(native Responses). This example does not recommend or select a model. Keep
credentials out of the JSON configuration, chat, Git and reports. On POSIX,
the API-key file must be private (`0600` or `0400`). Paths relative to the
configuration file are supported. Windows ACL qualification remains separate.
The account label must be a non-secret identifier, not an email address.

```sh
npm run evaluate -- --live-config /private/evaluation.json --allow-paid \
  --output /private/new-evaluation-report.json
```

There are at most three single-step generation requests, one per scenario, with
an explicit output cap of 1,024 tokens each. Provider-specific input/reasoning
billing still applies. An execution error stops remaining scenarios. There are
no automatic retries or provider/account/model fallbacks. Output-quality failure
continues to the next selected scenario so its separate score can be recorded.
No tools or real side effects are exposed in live mode, and the fixed synthetic
evidence is supplied directly without a paid embedding request.

Reports include the requested model, selected account label, operator-reported
provider version, SDK/source provenance and returned usage. The operator's
version label is explicitly marked as caller-reported; it is not verified native
runtime metadata or proof of a model snapshot. No raw output, provider error body,
API key or private file path is stored. JSON parse failure is a quality failure;
a provider/transport error remains a separate error code. No default inactivity
or total run deadline is added. Stop the CLI explicitly if needed.

No live provider evaluation has been run as part of implementing this suite.
