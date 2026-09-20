package agenticdriver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSharedVersionFixtures(t *testing.T) {
	var fixture struct {
		Cases []struct {
			ID            string            `json:"id"`
			Headers       map[string]string `json:"headers"`
			Status        int               `json:"status"`
			Events        []json.RawMessage `json:"events"`
			JSON          json.RawMessage   `json:"json"`
			ExpectedTypes []string          `json:"expectedTypes"`
			ExpectedError string            `json:"expectedError"`
			Retryable     bool              `json:"retryable"`
		}
	}
	raw, err := os.ReadFile("../../protocol/fixtures/versioning.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, example := range fixture.Cases {
		t.Run(example.ID, func(t *testing.T) {
			transport := fixtureTransport(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("AgenticDriver-Version") != ProtocolVersion || r.Header.Get("AgenticDriver-Accept-Optional-Events") != "true" {
					t.Fatal("missing negotiation headers")
				}
				headers := make(http.Header)
				headers.Set("Content-Type", "text/event-stream")
				for key, value := range example.Headers {
					headers.Set(key, value)
				}
				status := example.Status
				if status == 0 {
					status = 200
				}
				body := string(example.JSON)
				if example.Events != nil {
					body = ""
					for _, event := range example.Events {
						compact := &strings.Builder{}
						var value any
						_ = json.Unmarshal(event, &value)
						encoded, _ := json.Marshal(value)
						compact.Write(encoded)
						body += "data: " + compact.String() + "\n\n"
					}
				}
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			client, err := NewWithTransport("https://driver.example", "fixture-token", transport)
			if err != nil {
				t.Fatal(err)
			}
			var types []string
			err = client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "Hello"}, func(event Event) error { types = append(types, event.Type); return nil })
			if example.ExpectedError != "" {
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != example.ExpectedError || failure.Retryable != example.Retryable {
					t.Fatalf("expected %s, got %v", example.ExpectedError, err)
				}
			} else if err != nil || !reflect.DeepEqual(types, example.ExpectedTypes) {
				t.Fatalf("types %v, error %v", types, err)
			}
		})
	}
}
