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
			ID                   string `json:"id"`
			Operation            string `json:"operation"`
			ExpectedError        string `json:"expectedError"`
			ExpectTransportError bool   `json:"expectTransportError"`
			Cancel               bool   `json:"cancel"`
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
			} else {
				stop := errors.New("intentional stream close")
				completed, cancelled := false, false
				err = client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "Hello"}, func(event Event) error {
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
