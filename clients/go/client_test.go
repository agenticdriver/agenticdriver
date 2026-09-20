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
	request := Request{Provider: "mock", Model: "demo", Input: "Unicode 🌍 round trip", IdleTimeoutMs: 10000}
	result, err := client.Run(context.Background(), request)
	if err != nil || result.Text != "AgenticDriver is connected." {
		t.Fatalf("result: %v %v", result, err)
	}
	terminal := false
	err = client.Stream(context.Background(), request, func(event Event) error { terminal = event.Type == "run.completed"; return nil })
	if err != nil || !terminal {
		t.Fatalf("stream: %v", err)
	}
}
