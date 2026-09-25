package agenticdriver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestManagementPreservesModelAccessAndUsesDedicatedRoutes(t *testing.T) {
	raw, err := os.ReadFile("../../protocol/fixtures/management.json")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	c, err := NewWithTransport("https://driver.example", "fixture-operator", fixtureTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			if r.Method != "GET" || r.URL.Path != "/v1/management" {
				t.Fatal("wrong management route")
			}
		} else {
			var input map[string]any
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if r.URL.Path != "/v1/management/providers" || r.Method != "POST" {
				t.Fatal("wrong configure route")
			}
			models, ok := input["provider"].(map[string]any)["models"].([]any)
			if !ok || len(models) != 0 {
				t.Fatal("deny-all override was lost")
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := c.Management(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Providers[0].Models != nil || state.Providers[1].Models == nil || len(*state.Providers[1].Models) != 0 {
		t.Fatal("catalog access semantics changed")
	}
	if _, err = c.ConfigureProvider(context.Background(), ConfigureProvider{Revision: state.Revision, Provider: state.Providers[1]}); err != nil {
		t.Fatal(err)
	}
}
