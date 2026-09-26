package agenticdriver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func conformanceClient(t *testing.T, base, token string, trustCA bool) *Client {
	t.Helper()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	if ca := os.Getenv("AGENTICDRIVER_TEST_CA"); ca != "" && trustCA {
		raw, err := os.ReadFile(ca)
		if err != nil {
			t.Fatal(err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(raw) {
			t.Fatal("invalid fixture CA")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	client, err := NewWithTransport(base, token, transport)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestInteractiveApprovals(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_URL")
	if base == "" {
		t.Skip("requires reference host")
	}
	client := conformanceClient(t, base, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	for _, action := range []string{"approve", "deny", "cancel", "expire"} {
		t.Run(action, func(t *testing.T) {
			policy := &ApprovalPolicy{Mode: "interactive", IdlePolicy: "pause"}
			if action == "expire" {
				expiry := 20
				policy.ExpiresAfterMs = &expiry
			}
			var resolution *ApprovalResolution
			completed := false
			err := client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "conformance-approval", Tools: []string{"approved_echo"}, Approvals: policy}, func(event Event) error {
				if event.Type == "approval.requested" && action != "expire" {
					approval := event.Approval
					decision := ApprovalDecision{ApprovalID: approval.ApprovalID, RunID: approval.RunID, Call: approval.Call, Decision: action}
					receipt, err := client.DecideApproval(context.Background(), decision)
					if err != nil {
						return err
					}
					if receipt.CallID != approval.Call.ID {
						t.Fatal("mismatched receipt")
					}
					_, stale := client.DecideApproval(context.Background(), decision)
					var failure *Error
					if !errors.As(stale, &failure) || failure.Code != "APPROVAL_NOT_FOUND" {
						t.Fatalf("stale decision: %v", stale)
					}
				}
				if event.Type == "approval.resolved" {
					resolution = event.Resolution
				}
				if event.Type == "tool.completed" {
					completed = true
				}
				return nil
			})
			expected := map[string]string{"approve": "", "deny": "APPROVAL_DENIED", "cancel": "CANCELLED", "expire": "APPROVAL_EXPIRED"}[action]
			var failure *Error
			if expected == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.As(err, &failure) || failure.Code != expected {
				t.Fatalf("expected %s, got %v", expected, err)
			}
			if completed != (action == "approve") {
				t.Fatal("unexpected tool completion")
			}
			if resolution == nil || resolution.Outcome != map[string]string{"approve": "approved", "deny": "denied", "cancel": "cancelled", "expire": "expired"}[action] {
				t.Fatalf("unexpected resolution: %+v", resolution)
			}
		})
	}
}

func TestApplicationOwnedFunction(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_URL")
	if base == "" {
		t.Skip("requires reference host")
	}
	client := conformanceClient(t, base, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	for _, review := range []bool{false, true} {
		calls := 0
		lookup := func(arguments map[string]json.RawMessage) json.RawMessage {
			calls++
			var query string
			if err := json.Unmarshal(arguments["query"], &query); err != nil {
				t.Fatal(err)
			}
			result, _ := json.Marshal(map[string]any{"passages": []string{"Evidence for " + query}})
			return result
		}
		definition := ApplicationToolDefinition{Name: "application_lookup", Description: "Find application-owned evidence", RequiresApproval: review,
			InputSchema:  map[string]any{"type": "object", "required": []string{"query"}, "properties": map[string]any{"query": map[string]any{"type": "string"}}},
			OutputSchema: map[string]any{"type": "object", "required": []string{"passages"}, "properties": map[string]any{"passages": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}}}
		request := Request{Provider: "mock", Model: "demo", Input: "conformance-application-tool", Tools: []string{"application_lookup"}, ApplicationTools: []ApplicationToolDefinition{definition}}
		if review {
			request.Approvals = &ApprovalPolicy{Mode: "interactive", IdlePolicy: "pause"}
		}
		approved, completed := false, false
		err := client.Stream(context.Background(), request, func(event Event) error {
			if event.Type == "approval.requested" {
				approval := event.Approval
				_, err := client.DecideApproval(context.Background(), ApprovalDecision{ApprovalID: approval.ApprovalID, RunID: approval.RunID, Call: approval.Call, Decision: "approve"})
				if err != nil {
					return err
				}
				approved = true
			}
			if event.Type == "tool.execution.requested" {
				if approved != review {
					t.Fatal("execution occurred before required review")
				}
				identity := event.Execution.Identity()
				output := lookup(event.Execution.Call.Arguments)
				if _, err := client.ReportToolProgress(context.Background(), identity); err != nil {
					return err
				}
				value := ToolExecutionResult{ToolExecutionIdentity: identity, Output: output}
				if _, err := client.CompleteTool(context.Background(), value); err != nil {
					return err
				}
				_, stale := client.CompleteTool(context.Background(), value)
				var failure *Error
				if !errors.As(stale, &failure) || failure.Code != "TOOL_EXECUTION_NOT_FOUND" {
					t.Fatalf("stale result: %v", stale)
				}
			}
			if event.Type == "run.completed" {
				completed = true
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if !completed || calls != 1 {
			t.Fatalf("completed=%t calls=%d", completed, calls)
		}
	}
}

func TestReferencePeerConformance(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_REFERENCE_URL")
	if base == "" {
		t.Skip("requires reference host")
	}
	token := os.Getenv("AGENTICDRIVER_TEST_TOKEN")
	var fixture struct {
		Cases []struct {
			JobSubmit            JobSubmit                   `json:"jobSubmit"`
			JobIdentity          JobIdentity                 `json:"jobIdentity"`
			JobEvents            JobEventsRequest            `json:"jobEvents"`
			SessionCreate        SessionCreate               `json:"sessionCreate"`
			SessionIdentity      SessionIdentity             `json:"sessionIdentity"`
			Session              *SessionHandle              `json:"session"`
			ID                   string                      `json:"id"`
			ApplicationTools     []ApplicationToolDefinition `json:"applicationTools"`
			Tools                []string                    `json:"tools"`
			ToolIdentity         ToolExecutionIdentity       `json:"toolIdentity"`
			ToolResult           ToolExecutionResult         `json:"toolResult"`
			Approvals            *ApprovalPolicy             `json:"approvals"`
			Decision             ApprovalDecision            `json:"decision"`
			Retrieval            *RetrievalRequest           `json:"retrieval"`
			Operation            string                      `json:"operation"`
			ExpectedError        string                      `json:"expectedError"`
			ExpectTransportError bool                        `json:"expectTransportError"`
			Cancel               bool                        `json:"cancel"`
		}
	}
	raw, err := os.ReadFile("../../protocol/fixtures/conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, example := range fixture.Cases {
		t.Run(example.ID, func(t *testing.T) {
			client := conformanceClient(t, base+"/fixtures/"+example.ID, token, true)
			var err error
			if example.Operation == "providers" {
				_, err = client.Providers(context.Background())
			} else if example.Operation == "protocol" {
				_, err = client.Protocol(context.Background())
			} else if example.Operation == "job-submit" {
				_, err = client.SubmitJob(context.Background(), example.JobSubmit)
			} else if example.Operation == "job-read" {
				_, err = client.ReadJob(context.Background(), example.JobIdentity)
			} else if example.Operation == "job-cancel" {
				_, err = client.CancelJob(context.Background(), example.JobIdentity)
			} else if example.Operation == "job-events" {
				_, err = client.JobEvents(context.Background(), example.JobEvents)
			} else if example.Operation == "session-create" {
				_, err = client.CreateSession(context.Background(), example.SessionCreate)
			} else if example.Operation == "session-read" {
				_, err = client.ReadSession(context.Background(), example.SessionIdentity)
			} else if example.Operation == "session-delete" {
				_, err = client.DeleteSession(context.Background(), example.SessionIdentity)
			} else if example.Operation == "tool-result" {
				_, err = client.CompleteTool(context.Background(), example.ToolResult)
			} else if example.Operation == "tool-progress" {
				_, err = client.ReportToolProgress(context.Background(), example.ToolIdentity)
			} else if example.Operation == "approval" {
				_, err = client.DecideApproval(context.Background(), example.Decision)
			} else if example.Operation == "ingest" {
				_, err = client.IngestContext(context.Background(), IngestRequest{Corpus: "library", Document: IngestionDocument{Type: "reference", ID: "paper", Revision: "r1", MediaType: "text/markdown"}})
			} else {
				stop := errors.New("intentional stream close")
				completed, cancelled := false, false
				err = client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "Hello", Retrieval: example.Retrieval, Approvals: example.Approvals, ApplicationTools: example.ApplicationTools, Tools: example.Tools, Session: example.Session}, func(event Event) error {
					if example.Cancel && event.Type == "text.delta" {
						cancelled = true
						return stop
					}
					if event.Type == "run.completed" {
						completed = true
					}
					return nil
				})
				if errors.Is(err, stop) {
					err = nil
				}
				if err == nil && example.ExpectedError == "" && !example.ExpectTransportError && !(completed || cancelled) {
					t.Error("missing expected outcome")
				}
			}
			if example.ExpectedError != "" {
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != example.ExpectedError {
					t.Fatalf("expected %s; got %v", example.ExpectedError, err)
				}
			} else if example.ExpectTransportError {
				if err == nil {
					t.Fatal("redirect unexpectedly succeeded")
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDurableJobs(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_URL")
	if base == "" {
		t.Skip("requires host")
	}
	peer := conformanceClient(t, base, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	ctx := context.Background()
	input := JobSubmit{Key: "go-job", Request: Request{Provider: "mock", Model: "demo", Input: "Hello"}}
	job, err := peer.SubmitJob(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	same, err := peer.SubmitJob(ctx, input)
	if err != nil || same.ID != job.ID {
		t.Fatalf("dedup: %v", err)
	}
	for i := 0; i < 200 && job.State != "completed"; i++ {
		time.Sleep(10 * time.Millisecond)
		job, err = peer.ReadJob(ctx, JobIdentity{ID: job.ID})
		if err != nil {
			t.Fatal(err)
		}
	}
	if job.State != "completed" {
		t.Fatal(job.State)
	}
	var cursor int64
	for cursor < job.Cursor {
		page, err := peer.JobEvents(ctx, JobEventsRequest{ID: job.ID, After: cursor, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		cursor = page.NextCursor
	}
	finished, err := peer.CancelJob(ctx, JobIdentity{ID: job.ID})
	if err != nil || finished.State != "completed" {
		t.Fatalf("cancel terminal: %v", err)
	}
	input.Key = "go-job-cancel"
	input.Request.Input = "conformance-stall"
	job, err = peer.SubmitJob(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	job, err = peer.CancelJob(ctx, JobIdentity{ID: job.ID})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200 && job.State != "cancelled"; i++ {
		time.Sleep(10 * time.Millisecond)
		job, err = peer.ReadJob(ctx, JobIdentity{ID: job.ID})
		if err != nil {
			t.Fatal(err)
		}
	}
	if job.State != "cancelled" {
		t.Fatal(job.State)
	}
}

func TestRealHostConformance(t *testing.T) {
	base, token := os.Getenv("AGENTICDRIVER_TEST_URL"), os.Getenv("AGENTICDRIVER_TEST_TOKEN")
	if os.Getenv("AGENTICDRIVER_TEST_REFERENCE_URL") == "" {
		t.Skip("requires reference host")
	}
	request := Request{Provider: "mock", Model: "demo", Input: "Hello"}
	requireCode := func(err error, code string) {
		t.Helper()
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != code {
			t.Fatalf("expected %s; got %v", code, err)
		}
	}
	_, err := conformanceClient(t, base, "wrong-token", true).Run(context.Background(), request)
	requireCode(err, "UNAUTHORIZED")
	restricted := conformanceClient(t, base, token+"-restricted", true)
	providers, err := restricted.Providers(context.Background())
	if err != nil || len(providers) != 0 {
		t.Fatalf("restricted catalog: %v %v", providers, err)
	}
	_, err = restricted.Run(context.Background(), request)
	requireCode(err, "FORBIDDEN")
	client := conformanceClient(t, base, token, true)
	estimateRequest := request
	estimateRequest.Input = "conformance-cost"
	estimated, estimateError := client.Run(context.Background(), estimateRequest)
	if estimateError != nil || estimated.Usage.APIEquivalentCostUSD == nil || *estimated.Usage.APIEquivalentCostUSD != 0.25 || estimated.Usage.CostUSD != nil {
		t.Fatalf("estimated usage: %v %v", estimated, estimateError)
	}
	forbidden := request
	forbidden.Tools = []string{"echo"}
	_, err = client.Run(context.Background(), forbidden)
	requireCode(err, "FORBIDDEN")
	for _, mode := range []string{"quiet", "progress"} {
		input := request
		input.Input = "conformance-" + mode
		if mode == "progress" {
			input.IdleTimeoutMs = 150
		}
		result, err := client.Run(context.Background(), input)
		if err != nil || result.Text != "AgenticDriver is connected." {
			t.Fatalf("%s: %v %v", mode, result, err)
		}
	}
	request.Input, request.IdleTimeoutMs = "conformance-stall", 30
	_, err = client.Run(context.Background(), request)
	requireCode(err, "IDLE_TIMEOUT")
	if strings.HasPrefix(base, "https:") {
		if _, err := conformanceClient(t, base, token, false).Providers(context.Background()); err == nil {
			t.Fatal("untrusted certificate accepted")
		}
		if _, err := conformanceClient(t, strings.Replace(base, "127.0.0.1", "localhost", 1), token, true).Providers(context.Background()); err == nil {
			t.Fatal("invalid certificate hostname accepted")
		}
	}
}

func TestRetrieval(t *testing.T) {
	base, token := os.Getenv("AGENTICDRIVER_TEST_URL"), os.Getenv("AGENTICDRIVER_TEST_TOKEN")
	if base == "" {
		t.Skip("requires real host")
	}
	client := conformanceClient(t, base, token, true)
	ctx := context.Background()
	page := 2
	document := RetrievalIndexRequest{Corpus: "library", Source: ContextSource{ID: "go-paper", Revision: "r1"},
		Chunks: []RetrievalChunk{{ID: "go-p1", Text: "Solar batteries retain energy.", Location: &SourceLocation{Page: &page}}}}
	indexed, err := client.IndexContext(ctx, document)
	if err != nil || indexed.Status != "indexed" {
		t.Fatalf("index: %v %v", indexed, err)
	}
	search := RetrievalSearch{Corpus: "library", SourceIDs: []string{"go-paper"}, Query: "solar energy"}
	evidence, err := client.SearchContext(ctx, search)
	if err != nil || len(evidence.Hits) != 1 || evidence.Hits[0].ChunkID != "go-p1" {
		t.Fatalf("search: %v %v", evidence, err)
	}
	result, err := client.Run(ctx, Request{Provider: "mock", Model: "demo", Input: "Question", Retrieval: &search,
		OutputArtifact: &ArtifactRequest{Name: "answer.md", MediaType: "text/markdown"}})
	if err != nil || result.Retrieval == nil || result.Retrieval.Hits[0].Source.ID != "go-paper" || result.Sources[0].Origin != "retrieval" || result.Artifacts[0].SourceIDs[0] != "go-p1" {
		t.Fatalf("run: %v %v", result, err)
	}
	var completed bool
	err = client.Stream(ctx, Request{Provider: "mock", Model: "demo", Input: "Question", Retrieval: &search}, func(event Event) error { completed = event.Type == "run.completed"; return nil })
	if err != nil || !completed {
		t.Fatalf("stream: %v", err)
	}
	deleted, err := client.DeleteContext(ctx, RetrievalDelete{Corpus: "library", SourceID: "go-paper", Revision: "r1"})
	if err != nil || !deleted.Deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	evidence, err = client.SearchContext(ctx, search)
	if err != nil || len(evidence.Hits) != 0 {
		t.Fatalf("deleted search: %v %v", evidence, err)
	}
}

func TestIngestionRoundTrips(t *testing.T) {
	base, token := os.Getenv("AGENTICDRIVER_TEST_URL"), os.Getenv("AGENTICDRIVER_TEST_TOKEN")
	if base == "" {
		t.Skip("requires real host")
	}
	client := conformanceClient(t, base, token, true)
	ctx := context.Background()
	for _, format := range []string{"markdown", "email", "pdf", "reference"} {
		t.Run(format, func(t *testing.T) {
			source := ContextSource{ID: "go-" + format, Revision: "r1"}
			document := IngestionDocument{Type: "text", Source: &source, MediaType: "text/markdown", Text: "# Solar evidence\nEnergy from sunlight."}
			switch format {
			case "email":
				document = IngestionDocument{Type: "email", Source: &source, ThreadID: "thread-one", Messages: []EmailMessage{{ID: "message-one", Text: "Solar evidence."}}}
			case "pdf":
				document = IngestionDocument{Type: "pdf", Source: &source, MediaType: "application/pdf", Data: "JVBERi0xLjQKJSVFT0YK"}
			case "reference":
				source.ID = "ingestion-reference"
				document = IngestionDocument{Type: "reference", ID: source.ID, Revision: source.Revision, MediaType: "text/markdown"}
			}
			request := IngestRequest{Corpus: "library", Document: document}
			receipt, err := client.IngestContext(ctx, request)
			expected := format
			if expected == "reference" {
				expected = "markdown"
			}
			if err != nil || receipt.Ingestion == nil || receipt.Ingestion.Format != expected {
				t.Fatalf("ingest: %v %v", receipt, err)
			}
			repeated, err := client.IngestContext(ctx, request)
			if err != nil || repeated.Status != "unchanged" {
				t.Fatalf("dedup: %v %v", repeated, err)
			}
			result, err := client.Run(ctx, Request{Provider: "mock", Model: "demo", Input: "solar evidence", Retrieval: &RetrievalRequest{Corpus: "library", SourceIDs: []string{source.ID}}})
			if err != nil || result.Retrieval == nil || len(result.Retrieval.Hits) == 0 {
				t.Fatalf("run: %v %v", result, err)
			}
			hit := result.Retrieval.Hits[0]
			if hit.Ingestion == nil || hit.Ingestion.InputSHA256 != receipt.Ingestion.InputSHA256 || hit.Source.Location.DocumentID != source.ID {
				t.Fatalf("lost provenance: %v", hit)
			}
			if format == "pdf" && hit.Ingestion.Pages.Total != 2 {
				t.Fatal("lost pages")
			}
			if format == "email" && hit.Source.Location.MessageID != "message-one" {
				t.Fatal("lost email message")
			}
			if format == "markdown" && hit.Source.Location.Section != "Solar evidence" {
				t.Fatal("lost Markdown section")
			}
		})
	}
}

func TestConversationSessions(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_URL")
	if base == "" {
		t.Skip("requires reference host")
	}
	client := conformanceClient(t, base, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	ctx := context.Background()
	for _, mode := range []string{"history", "native"} {
		created, err := client.CreateSession(ctx, SessionCreate{Provider: "mock", Model: "demo", Mode: mode})
		if err != nil {
			t.Fatal(err)
		}
		identity := SessionIdentity{ID: created.Session.ID}
		request := Request{Provider: "mock", Model: "demo", Input: "session-first", Session: &SessionHandle{ID: identity.ID, Revision: 0}}
		first, err := client.Run(ctx, request)
		if err != nil || first.Session == nil || first.Session.Revision != 1 {
			t.Fatalf("first turn: %+v %v", first, err)
		}
		_, err = client.Run(ctx, request)
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != "SESSION_REVISION_CONFLICT" {
			t.Fatalf("stale turn: %v", err)
		}
		saved, err := client.ReadSession(ctx, identity)
		if err != nil || len(saved.History) != 2 {
			t.Fatalf("history: %+v %v", saved, err)
		}
		request.Input = "session-next"
		request.Session.Revision = 1
		completed := false
		err = client.Stream(ctx, request, func(event Event) error {
			if event.Type == "run.completed" {
				if event.Result.Text != "continued" || event.Result.Session == nil || event.Result.Session.Revision != 2 {
					t.Fatalf("continuation: %+v", event.Result)
				}
				completed = true
			}
			return nil
		})
		if err != nil || !completed {
			t.Fatalf("continuation: %v", err)
		}
		if _, err = client.DeleteSession(ctx, identity); err != nil {
			t.Fatal(err)
		}
		_, err = client.ReadSession(ctx, identity)
		if !errors.As(err, &failure) || failure.Code != "SESSION_NOT_FOUND" {
			t.Fatalf("deleted session: %v", err)
		}
	}
}

func TestManagementRoundtrip(t *testing.T) {
	url := os.Getenv("AGENTICDRIVER_TEST_MANAGEMENT_URL")
	if url == "" {
		t.Skip("requires reference host")
	}
	manager := conformanceClient(t, url, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	before, err := manager.Management(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before.ProviderDefinitions == nil || (*before.ProviderDefinitions)[0].Methods[0].Interaction != "external" {
		t.Fatal("setup metadata lost")
	}
	empty := []string{}
	input := ConfigureProvider{Revision: before.Revision, Provider: ProviderConfiguration{ID: "go-fixture", Kind: "mock", Models: &empty}}
	panel := ProviderPanel{Client: func(context.Context) (*Client, error) { return manager, nil }}
	request, _ := json.Marshal(map[string]any{"action": "configure", "change": input})
	panelResult, err := panel.Handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	panelState := panelResult.(map[string]any)
	next := panelState["management"].(ManagementSnapshot)
	if next.ExecutionProviders == nil {
		t.Fatal("missing execution grant metadata")
	}
	for _, p := range panelState["providers"].([]map[string]any) {
		if p["id"] == "go-fixture" && len(p["models"].([]string)) != 0 {
			t.Fatal("panel broadened deny-all access")
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range next.Providers {
		if p.ID == "go-fixture" {
			found = p.Models != nil && len(*p.Models) == 0
		}
	}
	if !found {
		t.Fatal("deny-all override changed in transport")
	}
	_, err = manager.ConfigureProvider(context.Background(), input)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != "CONFIG_CONFLICT" {
		t.Fatal("stale settings accepted")
	}
}

func TestConnectionPairing(t *testing.T) {
	url := os.Getenv("AGENTICDRIVER_TEST_MANAGEMENT_URL")
	if url == "" {
		t.Skip("requires reference host")
	}
	manager := conformanceClient(t, url, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), true)
	invitation, err := manager.CreateInvitation(context.Background(), CreateInvitation{Grant: ConnectionGrant{Subject: "go-pairing", Providers: []string{"fixture"}}})
	if err != nil {
		t.Fatal(err)
	}
	pairing := conformanceClient(t, url, invitation.Code, true)
	credential, err := pairing.ExchangeConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = pairing.ExchangeConnection(context.Background())
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != "INVITATION_REJECTED" {
		t.Fatal("invitation replay accepted")
	}
	connected := conformanceClient(t, url, credential.Token, true)
	providers, err := connected.Providers(context.Background())
	if err != nil || len(providers) != 1 || providers[0].ID != "fixture" {
		t.Fatal("wrong connection scope", err)
	}
	_, err = connected.Management(context.Background())
	if !errors.As(err, &failure) || failure.Code != "FORBIDDEN" {
		t.Fatal("scope elevation accepted")
	}
	revoked, err := manager.RevokeConnection(context.Background(), credential.ID)
	if err != nil || !revoked {
		t.Fatal("revocation failed", err)
	}
	_, err = connected.Providers(context.Background())
	if !errors.As(err, &failure) || failure.Code != "UNAUTHORIZED" {
		t.Fatal("revoked credential accepted")
	}
}
