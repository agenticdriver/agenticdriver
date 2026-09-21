# AgenticDriver Go client

Connect a Go 1.22+ application to its local or remote AgenticDriver host. This module has no external Go dependencies. Provider credentials and native agent processes stay on the host. The client uses an application-scoped driver bearer token and explicit provider/model selection.

Until release tags are published, pin a reviewed commit on `sdk-roadmap`:

```sh
GOPRIVATE=github.com/hashimkarim/agenticdriver go get github.com/hashimkarim/agenticdriver/clients/go@COMMIT_SHA
```

Go resolves the commit to an immutable pseudoversion in your application's `go.mod`/`go.sum`. No sibling checkout, `replace` directive or workspace is required. Tags, when published, use the monorepo module prefix `clients/go/vX.Y.Z`; package release work is tracked separately. Inspect a commit before choosing it; the placeholders here do not mean “use latest automatically.”

The repository is currently private, so installation requires repository access and an existing Git credential helper (for example, `gh auth setup-git` after signing in). `GOPRIVATE` keeps this module's lookup away from public proxies and checksum databases. If your application already uses private module patterns, append this repository to that list. The installation check below sets this scope for its temporary environment without changing your global Go configuration.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "os"
    "os/signal"

    "github.com/hashimkarim/agenticdriver/clients/go"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
    defer stop()
    client, err := agenticdriver.New(os.Getenv("AGENTICDRIVER_URL"), os.Getenv("AGENTICDRIVER_TOKEN"))
    if err != nil { panic(err) }
    providers, err := client.RefreshProviders(ctx)
    if err != nil { panic(err) }
    fmt.Printf("Authorized provider instances: %d\n", len(providers))
    request := agenticdriver.Request{
        Provider: os.Getenv("AGENTICDRIVER_PROVIDER"),
        Model: os.Getenv("AGENTICDRIVER_MODEL"),
        Input: "Summarize the selected evidence.",
    }
    err = client.Stream(ctx, request, func(event agenticdriver.Event) error {
        switch event.Type {
        case "text.delta": fmt.Print(event.Text)
        case "run.progress": fmt.Printf("Progress: %s\n", event.Phase)
        case "run.completed": fmt.Printf("\nRun: %s\n", event.Result.RunID)
        }
        return nil // Return an application error to stop consuming and cancel the run.
    })
    if err != nil {
        var driverError *agenticdriver.Error
        if errors.As(err, &driverError) {
            fmt.Printf("%s: %s\n", driverError.Code, driverError.Message)
            // Outcome == "uncertain" requires reconciliation before replacing work.
            // Retryable is advisory; the client never replays a run automatically.
        } else if errors.Is(err, context.Canceled) {
            fmt.Println("Cancelled")
        } else { panic(err) }
    }
}
```

`Run(ctx, request)` returns a typed `Result`; `Stream` exposes typed model, step, progress, tool, usage, error and result fields plus each validated event's `Raw` JSON. Check the event type before reading its associated fields. Pointer token counters distinguish a reported zero from an unknown measurement. Callback errors return unchanged. The callback runs synchronously, so applications control buffering/backpressure and must return promptly when they want cancellation to finish; the SDK cannot interrupt arbitrary application code.

A stream owns its response body and derived cancellation context. Terminal success, malformed frames, transport failures, context cancellation and callback termination close that body. A nil callback is rejected before HTTP with `INVALID_CALLBACK`. SSE supports UTF-8, BOM, LF/CR/CRLF, multiline data and any network-read boundaries, including bytes returned together with EOF. EOF without a terminal event remains an error; it never turns an incomplete answer into success. There is no reconnection or implicit replay.

`SearchContext`, `IndexContext`, `IngestContext` and `DeleteContext` expose the shared retrieval/ingestion contract. Their inputs include corpus and exact source/revision; manifests preserve extraction coverage and source provenance. Canonical data, access control and citation validity remain application-owned.

HTTPS is required away from loopback, and redirects never forward credentials. For a custom CA, mTLS or proxy policy, configure a verified `http.Transport` and pass it to `NewWithTransport`. The caller owns that transport and any `CloseIdleConnections` lifecycle. Do not disable TLS verification. No HTTP-client execution timeout is installed. Caller context deadlines are explicit application choices; runs can separately opt in to host-enforced `IdleTimeoutMs` based on real model/tool/context progress. Discovery has a bounded ten-second I/O timeout. A background context gives an execution request no default deadline.

Development checks in the SDK repository:

```sh
# Pure Go framing/cleanup checks (including the EOF+CRLF regression):
go test -race ./...                    # from clients/go
# All language clients over HTTP and verified HTTPS, with Go's race detector:
npm run test:clients                   # from repository root
# Fetch a pushed client into a separate module, without relative replacements:
python3 scripts/test-go-install.py COMMIT_SHA
```

## Interactive approvals

Set `Request.Approvals` to `&ApprovalPolicy{Mode: "interactive", IdlePolicy: "pause"}` and consume `Stream`. `Event.Approval` contains the reviewed call; submit `DecideApproval(ctx, ApprovalDecision{ApprovalID: approval.ApprovalID, RunID: approval.RunID, Call: approval.Call, Decision: "approve"})` using the same authenticated subject with a separate approval grant. Decisions may also be `deny` or `cancel`; inspect `Event.Resolution` and the terminal run outcome.

The host must enable this feature and grant `approveTools`. `run` rejects
interactive mode because it cannot deliver review requests. There is no default
approval expiry; choose `expiresAfterMs` / the typed equivalent when needed.
Decisions are single-use and are never retried automatically. A receipt does not
confirm a tool effect. See the [approval contract](https://github.com/hashimkarim/agenticdriver/blob/sdk-roadmap/docs/approvals.md).

## Functions in your application

Set `Request.ApplicationTools` to your `[]ApplicationToolDefinition` and select
the same names in `Tools`. In `Stream`, dispatch only `tool.execution.requested`:
`event.Execution` contains the call arguments and `Identity()` for replies.
Use `ReportToolProgress(ctx, identity)` after real work and
`CompleteTool(ctx, ToolExecutionResult{ToolExecutionIdentity: identity, Output: jsonBytes})`
to submit the JSON result once. Output is `json.RawMessage`; encode a JSON null
as `json.RawMessage("null")`. On callback failure set only
`Error: "APPLICATION_TOOL_FAILED"`, without private exception text.

Host opt-in and named token grants are required; review defaults to required.
Pass the stream's context to your application function so cancellation propagates
through its I/O. Cancelled runs invalidate pending tickets but cannot undo effects.
No default inactivity deadline or automatic retries apply. See the
[full contract](https://github.com/hashimkarim/agenticdriver/blob/sdk-roadmap/docs/application-tools.md).
