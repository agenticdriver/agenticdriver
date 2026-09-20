package agenticdriver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
	"testing"
)

func TestRejectInsecureURLs(t *testing.T) {
	for _, url := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com?token=secret"} {
		if _, err := New(url, "token"); err == nil {
			t.Fatalf("accepted %s", url)
		}
	}
}
func TestProtocolRoundTrip(t *testing.T) {
	url := os.Getenv("AGENTICDRIVER_TEST_URL")
	if url == "" {
		t.Skip("run npm run test:clients to start a real host")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if ca := os.Getenv("AGENTICDRIVER_TEST_CA"); ca != "" {
		pem, err := os.ReadFile(ca)
		if err != nil {
			t.Fatal(err)
		}
		pool, _ := x509.SystemCertPool()
		if pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			t.Fatal("invalid test CA")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	client, err := NewWithTransport(url, os.Getenv("AGENTICDRIVER_TEST_TOKEN"), transport)
	if err != nil {
		t.Fatal(err)
	}
	providers, err := client.Providers(context.Background())
	if err != nil || len(providers) != 1 || providers[0].ID != "mock" {
		t.Fatalf("catalog: %v %v", providers, err)
	}
	providers, err = client.RefreshProviders(context.Background())
	if err != nil || len(providers) != 1 || providers[0].Health == nil || providers[0].Health.Code != "DISCOVERY_UNSUPPORTED" || providers[0].ModelCatalog == nil || providers[0].ModelCatalog.Source != "configured" {
		t.Fatalf("refreshed catalog: %v %v", providers, err)
	}
	protocol, err := client.Protocol(context.Background())
	if err != nil || protocol.Version != ProtocolVersion {
		t.Fatalf("protocol: %v %v", protocol, err)
	}
	request := Request{Provider: "mock", Model: "demo", Input: "Unicode 🌍 round trip", IdleTimeoutMs: 10000}
	result, err := client.Run(context.Background(), request)
	if err != nil || result.Text != "AgenticDriver is connected." {
		t.Fatalf("result: %v %v", result, err)
	}
	request.IdempotencyKey = "go-client"
	request.Retry = &RetryPolicy{MaxAttempts: 1}
	accepted, err := client.Run(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := client.Run(context.Background(), request)
	if err != nil || replayed.RunID != accepted.RunID {
		t.Fatalf("replay: %v %v", replayed, err)
	}
	changed := request
	changed.Input = "changed"
	_, err = client.Run(context.Background(), changed)
	if failure, ok := err.(*Error); !ok || failure.Code != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("conflict: %v", err)
	}
	changed.IdempotencyKey = ""
	changed.Input = "conformance-uncertain"
	_, err = client.Run(context.Background(), changed)
	if failure, ok := err.(*Error); !ok || failure.Outcome != "uncertain" || failure.Code != "IDLE_TIMEOUT" || failure.Retryable {
		t.Fatalf("uncertain: %v", err)
	}
	terminal := false
	err = client.Stream(context.Background(), request, func(event Event) error { terminal = event.Type == "run.completed"; return nil })
	if err != nil || !terminal {
		t.Fatalf("stream: %v", err)
	}
}
