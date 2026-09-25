package agenticdriver

import (
	"context"
	"strings"
	"testing"
)

func TestPanelAssetsAndConnectionHooks(t *testing.T) {
	if !strings.Contains(string(ProviderPanelScript), "agenticdriver-providers") {
		t.Fatal("component missing from package")
	}
	markup, err := ProviderPanelHTML("/settings/driver", "")
	if err != nil || !strings.Contains(markup, `api="/settings/driver"`) {
		t.Fatal(markup, err)
	}
	for _, path := range []string{"https://untrusted.example", "//untrusted.example", "/a/../b"} {
		if _, err := ProviderPanelHTML(path, ""); err == nil {
			t.Fatal("unsafe panel asset path accepted")
		}
	}
	seen := ""
	panel := ProviderPanel{Client: func(context.Context) (*Client, error) { return nil, nil },
		Connect:    func(_ context.Context, invitation string) error { seen = invitation; return nil },
		Disconnect: func(context.Context) error { seen = ""; return nil },
	}
	_, err = panel.Handle(context.Background(), []byte(`{"action":"connect","invitation":"application-hook"}`))
	if err != nil || seen != "application-hook" {
		t.Fatal(err, seen)
	}
	_, err = panel.Handle(context.Background(), []byte(`{"action":"disconnect"}`))
	if err != nil || seen != "" {
		t.Fatal(err, seen)
	}
	state, err := panel.Snapshot(context.Background(), false)
	if err != nil || state["connected"] != false {
		t.Fatal(err, state)
	}
}
