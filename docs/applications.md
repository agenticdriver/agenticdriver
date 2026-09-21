# Three application integrations

These integrations use the same SDK and keep each application's existing domain
logic. All dependency references currently point at a sibling `agenticdriver`
checkout. Build that checkout before installing or running a consumer. Package
registry publication is a separate release step.

All three applications can use the shared [provider identity, icon and quota helpers](catalog.md). The recipe keeps Usagestat probes, account quota bindings and raw filesystem paths on trusted servers, and exposes only reviewed image assets and scoped display data to each app.

## Brandstorm

`../brandstorm/packages/provider-agenticdriver` implements Brandstorm's existing
`ModelAdapter`. It is registered in the Bridge's provider factory and supported
by local configuration, announcements, and server connection contracts.

Build and run an AgenticDriver host, then configure a Bridge adapter with:

```json
{
  "id": "shared-driver",
  "name": "My AgenticDriver host",
  "provider": "agenticdriver",
  "baseUrl": "http://127.0.0.1:7433",
  "model": "mock/demo",
  "enabled": true
}
```

Store the driver bearer token through Bridge's existing keychain-backed API-key
configuration. For a remote host use its HTTPS URL. Do not put the token in the
base URL or model ID. Models use `provider-instance/model`, and discovery lists
the enabled models exposed by the token's allowed instances.

The adapter forwards instructions, messages, JSON output schema, cancellation,
and application run IDs. It normalizes text, usage, completion, and
structured output into Brandstorm's event contract. It currently accepts text
and JSON artifact requests; attachments and application tools fail explicitly.
This connection is configured through Bridge, not as a direct cloud API provider.
The SDK adds no default run timer; Brandstorm retains control of its own run
lifecycle and abort signals.

Run `pnpm typecheck` and `pnpm test` in Brandstorm. The SDK also includes the
standalone `examples/brandstorm.ts` demo.

## LitAgent / agentic-literature-review

`../agentic-literature-review/packages/agents/src/agenticdriver.ts` adds a driver
catalog alongside the existing CLI providers. The server opts in when both
environment variables are supplied:

```bash
export AGENTICDRIVER_URL=http://127.0.0.1:7433
# Supply the token from your shell/session secret storage.
export AGENTICDRIVER_TOKEN=YOUR_DRIVER_TOKEN
bun run dev:server
```

Scoped instances appear as `driver.<instance>`, for example `driver.mock`.
Enable an instance through LitAgent's existing provider settings and choose an
explicit model (`demo` for the mock host). The startup catalog reflects actual
authenticated discovery; restart the backend to refresh host inventory.

Start, interrupt, stop, completion, failure classification, and NDJSON logging
use LitAgent's existing lifecycle. Final text is saved under
`.litagent/cache/provider-runs/` and returned to existing research workflows as
a proposed artifact. Remote agents cannot read the research repository's files;
the application supplies selected research context. The direct citation-backed
Q&A workflow already builds this context from its passage index.

Keep accepting/rejecting proposed metadata, relevance, and synthesis changes in
the application. A returned citation identifier is not independent evidence of
a claim's correctness; LitAgent's existing evidence-linking layer remains
responsible for source provenance.

Run `bun run typecheck` and `bun run test`. The SDK's
`examples/literature-review.ts` demonstrates an application-owned passage search
tool and citation IDs validated against the supplied corpus.

## AI Workspace

`../ai-workspace/src/agent.ts` is the first backend feature in that concept
repository. `createWorkspaceDriver` accepts a provider list and a mailbox
interface. `triageThread` produces validated thread summary, priority, category,
reply draft, and task suggestions.

```ts
const driver = createWorkspaceDriver({ providers: [yourProvider], mailbox });
const proposal = await triageThread(driver, {
  subject: authenticatedUser.id,
  threadId: selectedThread.id,
  provider: "openai",
  model: "YOUR_MODEL",
});
```

The mailbox tool receives the authenticated subject from the execution context.
Implement `Mailbox.thread(subject, threadId)` against your eventual mail store
and enforce ownership there. The tool schema rejects user-supplied identity
overrides. The output schema requires the requested thread ID.

The workflow uses application tools and therefore requires an API or compatible
adapter. For CLI-based processing, the SDK's `examples/email-workspace.ts`
demonstrates supplying a selected email thread directly as text context.

The current backend does not include Gmail/Graph OAuth, mail synchronization, a
database, a UI, or message sending. Its demo uses synthetic data and its tests
check identity propagation and rejection of unregistered mail-sending tools.
Run `npm run check` and `npm run demo` in AI Workspace.
