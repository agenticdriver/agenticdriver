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

func TestReferencePeerConformance(t *testing.T) {
	base := os.Getenv("AGENTICDRIVER_TEST_REFERENCE_URL")
	if base == "" {
		t.Skip("requires reference host")
	}
	token := os.Getenv("AGENTICDRIVER_TEST_TOKEN")
	var fixture struct {
		Cases []struct {
			ID                   string            `json:"id"`
			Retrieval            *RetrievalRequest `json:"retrieval"`
			Operation            string            `json:"operation"`
			ExpectedError        string            `json:"expectedError"`
			ExpectTransportError bool              `json:"expectTransportError"`
			Cancel               bool              `json:"cancel"`
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
			} else if example.Operation == "ingest" {
				_, err = client.IngestContext(context.Background(), IngestRequest{Corpus: "library", Document: IngestionDocument{Type: "reference", ID: "paper", Revision: "r1", MediaType: "text/markdown"}})
			} else {
				stop := errors.New("intentional stream close")
				completed, cancelled := false, false
				err = client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "Hello", Retrieval: example.Retrieval}, func(event Event) error {
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
