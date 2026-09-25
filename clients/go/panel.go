package agenticdriver

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"html"
	"strings"
)

//go:embed provider-panel.js
var ProviderPanelScript []byte

func ProviderPanelHTML(apiPath, modulePath string) (string, error) {
	if apiPath == "" {
		apiPath = "/api/agenticdriver-panel"
	}
	if modulePath == "" {
		modulePath = "/assets/agenticdriver-panel.js"
	}
	for _, path := range []string{apiPath, modulePath} {
		if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "?#\\ \r\n\t") || strings.Contains("/"+path+"/", "/../") {
			return "", &Error{Code: "INVALID_PANEL_PATH", Message: "Use same-origin absolute asset and API paths."}
		}
	}
	return `<agenticdriver-providers api="` + html.EscapeString(apiPath) + `"></agenticdriver-providers><script type="module" src="` + html.EscapeString(modulePath) + `"></script>`, nil
}

type PanelConnection struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	URL   string `json:"url,omitempty"`
}

// ProviderPanel is mounted behind the application's settings authorization and CSRF checks.
type ProviderPanel struct {
	Client     func(context.Context) (*Client, error)
	Connection func() *PanelConnection
	Connect    func(context.Context, string) error
	Disconnect func(context.Context) error
}

func (p *ProviderPanel) Snapshot(ctx context.Context, refresh bool) (map[string]any, error) {
	client, err := p.Client(ctx)
	if err != nil {
		return nil, err
	}
	state := map[string]any{"connected": client != nil, "providers": []any{}, "canConnect": p.Connect != nil, "canDisconnect": p.Disconnect != nil, "canInvite": false}
	var connection *PanelConnection
	if p.Connection != nil {
		connection = p.Connection()
		if connection != nil {
			state["connection"] = connection
		}
	}
	if client == nil {
		return state, nil
	}
	var providers []Provider
	if refresh {
		providers, err = client.RefreshProviders(ctx)
	} else {
		providers, err = client.Providers(ctx)
	}
	if err != nil {
		return nil, err
	}
	entries := []map[string]any{}
	for _, provider := range providers {
		raw, _ := json.Marshal(provider)
		entry := map[string]any{}
		if err = json.Unmarshal(raw, &entry); err != nil {
			return nil, err
		}
		// Preserve an empty deny-all allowlist; omitempty alone would incorrectly remove it.
		if provider.Models != nil {
			entry["models"] = provider.Models
		}
		entries = append(entries, entry)
	}
	state["providers"] = entries
	protocol, err := client.Protocol(ctx)
	if err != nil {
		return nil, err
	}
	management, pairing := false, false
	for _, feature := range protocol.Features {
		management = management || feature == "provider-management"
		pairing = pairing || feature == "client-pairing"
	}
	if management {
		info, err := client.Management(ctx)
		if err != nil {
			return nil, err
		}
		state["management"] = info
		state["canInvite"] = pairing && connection != nil && connection.URL != ""
	}
	return state, nil
}
func (p *ProviderPanel) Handle(ctx context.Context, raw []byte) (any, error) {
	if len(raw) > 1_000_000 {
		return nil, &Error{Code: "BODY_TOO_LARGE", Message: "The panel request is too large."}
	}
	var request struct {
		Action     string            `json:"action"`
		Refresh    bool              `json:"refresh"`
		Invitation string            `json:"invitation"`
		Change     ConfigureProvider `json:"change"`
		ID         string            `json:"id"`
		Subject    string            `json:"subject"`
		Providers  []string          `json:"providers"`
		Manage     bool              `json:"manageProviders"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, &Error{Code: "INVALID_PANEL_REQUEST", Message: "Use a valid panel request."}
	}
	if request.Action == "snapshot" {
		return p.Snapshot(ctx, request.Refresh)
	}
	if request.Action == "connect" && p.Connect != nil {
		if len(request.Invitation) > 16384 {
			return nil, &Error{Code: "INVALID_INVITATION", Message: "Use a complete host invitation."}
		}
		if err := p.Connect(ctx, request.Invitation); err != nil {
			return nil, err
		}
		return p.Snapshot(ctx, false)
	}
	if request.Action == "disconnect" && p.Disconnect != nil {
		if err := p.Disconnect(ctx); err != nil {
			return nil, err
		}
		return p.Snapshot(ctx, false)
	}
	client, err := p.Client(ctx)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, &Error{Code: "CONNECTION_REQUIRED", Message: "Connect an AgenticDriver host first."}
	}
	switch request.Action {
	case "configure":
		if _, err := client.ConfigureProvider(ctx, request.Change); err != nil {
			return nil, err
		}
		return p.Snapshot(ctx, false)
	case "connections":
		return client.Connections(ctx)
	case "revoke":
		revoked, err := client.RevokeConnection(ctx, request.ID)
		return map[string]bool{"revoked": revoked}, err
	case "invite":
		var connection *PanelConnection
		if p.Connection != nil {
			connection = p.Connection()
		}
		if connection == nil || connection.URL == "" {
			return nil, &Error{Code: "CONNECTION_UNAVAILABLE", Message: "Configure the host's public connection URL."}
		}
		invitation, err := client.CreateInvitation(ctx, CreateInvitation{Grant: ConnectionGrant{Subject: request.Subject, Providers: request.Providers, ManageProviders: request.Manage}})
		if err != nil {
			return nil, err
		}
		return map[string]any{"invitation": "ad1." + base64.RawURLEncoding.EncodeToString([]byte(connection.URL)) + "." + invitation.Code, "expiresAt": invitation.ExpiresAt, "grant": invitation.Grant}, nil
	}
	return nil, &Error{Code: "INVALID_PANEL_REQUEST", Message: "Choose a supported provider panel operation."}
}
