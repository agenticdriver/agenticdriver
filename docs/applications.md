# Three application recipes

These recipes run against the installed SDK and keep canonical data and decisions
in the application. They use **synthetic data and a scripted mock provider**;
none reads a real mailbox, performs paid inference or certifies a native account.
The application integration issues [AD-033](roadmap.md#ad-033),
[AD-035](roadmap.md#ad-035) and [AD-037](roadmap.md#ad-037) track separate live
acceptance for Brandstorm, LitAgent and AI Workspace.

Install the npm archive from the [quickstart](quickstart.md). Each recipe is
included in that package. Copy it into a fresh application directory before
running it; Node does not strip TypeScript inside `node_modules`:

```sh
node -e 'for (const name of ["brandstorm", "literature-review", "email-workspace"]) require("node:fs").copyFileSync("node_modules/agenticdriver/examples/javascript/" + name + ".mts", name + ".mts")'
node --experimental-strip-types brandstorm.mts
node --experimental-strip-types literature-review.mts
node --experimental-strip-types email-workspace.mts
```

Node 22.13+ supports the explicit type-stripping flag. The package gate typechecks
and executes these exact installed examples on the supported runtime matrix.
They always select the mock, regardless of provider credentials in the shell.

## Brandstorm: turn a brief into directions

The [Brandstorm recipe](../examples/javascript/brandstorm.mts) produces three
schema-validated directions: Mossline, Commonlight and Formwell. It uses the
selected brief and explicit instructions, and labels the result as a proposal.
It makes no trademark or domain-availability claim.

In [Brandstorm](https://github.com/hashimkarim/brandstorm), connect its existing
model adapter to an authenticated host, refresh the authorized instance/model
catalog, and retain the user's explicit selection. Scope the run to that project's
selected brief and document revisions. Save the returned directions as a draft
revision; the user accepts or edits them in Brandstorm. Abort the run when the
application cancels it, and keep durable run IDs with its existing job state.

For questions over existing brand material, ingest chosen brief/Markdown/PDF
sources into a project corpus using [ingestion](ingestion.md), then supply a
[retrieval](retrieval.md) request with the chosen source IDs. Keep source access
and revision checks in Brandstorm. The vector index is derived data, not the
canonical brand record. Extend to tools only when the selected adapter advertises
them and the application grants the exact tool names.

## Literature review: answers tied to evidence

The [literature recipe](../examples/javascript/literature-review.mts) registers an
application-owned passage search tool, returns an answer and validates its
citation against the supplied synthetic passage ID. Its displayed claim is
explicitly a fixture, not a scientific finding.

In [LitAgent](https://github.com/hashimkarim/agentic-literature-review), keep papers,
PDFs/Markdown, search selections and workflow checkpoints authoritative. Ingest
selected source revisions with page, section and passage locations. Send their
IDs in retrieval requests, return navigable citations, and reject identifiers
outside the actual retrieved evidence. In real search tools, enforce the current
authenticated subject's corpus access; a prompt or model-supplied ID cannot grant
access to another user's paper.

Use [durable jobs](jobs.md) for resumable research stages when appropriate, with
an explicit current-grant resolver. Job replay and [idempotency](idempotency.md)
recover execution state; the application decides whether a relevance judgment,
metadata change or synthesis is accepted. Return insufficient evidence when
selected context cannot support an answer. Scanned PDFs require an explicitly
configured OCR adapter; empty extraction is not an empty research finding.

## Email workspace: proposals before actions

The [email recipe](../examples/javascript/email-workspace.mts) summarizes a
synthetic thread, drafts a reply and suggests a task. It registers no mail-sending
tool and does not claim that a message was sent or a task created.

In [AI Workspace](https://github.com/hashimkarim/ai-workspace), mailbox OAuth,
message synchronization and ownership belong to the application. Better Auth and
AuthYard govern application identities and sessions; the mail provider's own
OAuth consent separately authorizes mailbox access. Resolve a selected thread
through the authenticated subject before sending context to the SDK.

For questions spanning threads, index authorized message revisions with stable
thread/message IDs and query only the selected source set. Show those source
locations alongside the answer. Keep emails as untrusted content: retrieved
instructions cannot register tools, widen grants or trigger sending. Store a
draft proposal first. A later send/archive/label tool needs an explicit grant,
application approval and a current revision check immediately before execution.
Use [interactive approvals](approvals.md) and [application tools](application-tools.md)
for that flow, with uncertain-action reconciliation before any retry.

## Shared application contract

All three applications follow the same sequence:

1. Authenticate through their own Better Auth runtime paired with AuthYard; map
   canonical user/device or backend-service grants into SDK permissions.
2. Discover the host's authorized providers and capabilities, then select the
   account instance and exact model deliberately. Credentials stay on the host.
3. Resolve current access to selected source IDs, ingest revisions and run with
   bounded context, retrieval and explicitly permitted tools.
4. Display streamed progress and expose cancellation. No SDK run or inactivity
   timer is enabled by default; an app may choose a positive inactivity policy.
5. Validate schemas, revisions, citation identifiers and approvals before accepting
   a result into canonical application state.
6. Attribute execution to stable host/account/subject identities and forward it
   to the existing [Usagestat dependency](usagestat.md). Reuse its reviewed
   [provider logos, metadata and quota freshness](catalog.md).

An API or compatible adapter supports the SDK's tool loop. Restricted native
subscription adapters have narrower capabilities; supplying selected text/RAG
context does not imply native filesystem, mailbox or tool access. Read the
[provider status](providers.md) and [auth integration guide](authentication.md)
before substituting a live route for these fixtures.
