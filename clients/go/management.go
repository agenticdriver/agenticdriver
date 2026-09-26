package agenticdriver

import (
	"context"
	"regexp"
	"strings"
)

// ProviderConfiguration contains secret references, never resolved secret values.
type ProviderConfiguration struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	AccountID string `json:"accountId,omitempty"`
	Name      string `json:"name,omitempty"`
	Enabled   *bool  `json:"enabled,omitempty"`
	// nil permits every explicitly selected model; a pointer to an empty slice denies all.
	Models           *[]string           `json:"models,omitempty"`
	APIKeyRef        map[string]any      `json:"apiKeyRef,omitempty"`
	BaseURL          string              `json:"baseUrl,omitempty"`
	Binary           string              `json:"binary,omitempty"`
	AccountDirectory string              `json:"accountDirectory,omitempty"`
	ReasoningEffort  string              `json:"reasoningEffort,omitempty"`
	ApplicationTools string              `json:"applicationTools,omitempty"`
	InputMediaTypes  map[string][]string `json:"inputMediaTypes,omitempty"`
	ExtensionID      string              `json:"extensionId,omitempty"`
	ExtensionVersion string              `json:"extensionVersion,omitempty"`
	Settings         map[string]any      `json:"settings,omitempty"`
	SecretRefs       map[string]any      `json:"secretRefs,omitempty"`
}

// ProviderConnectionMethod describes setup only; it does not grant execution.
type ProviderConnectionMethod struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	Description     string `json:"description"`
	Interaction     string `json:"interaction"`
	CredentialOwner string `json:"credentialOwner"`
}
type ProviderDefinition struct {
	Kind         string                     `json:"kind"`
	Name         string                     `json:"name"`
	Description  string                     `json:"description"`
	Category     string                     `json:"category"`
	Protocol     string                     `json:"protocol"`
	Methods      []ProviderConnectionMethod `json:"methods"`
	Requirements string                     `json:"requirements,omitempty"`
	DocsURL      string                     `json:"docsUrl,omitempty"`
}
type ManagementSnapshot struct {
	Version             int                     `json:"version"`
	Revision            string                  `json:"revision"`
	Providers           []ProviderConfiguration `json:"providers"`
	SupportedKinds      []string                `json:"supportedKinds"`
	ProviderDefinitions *[]ProviderDefinition   `json:"providerDefinitions,omitempty"`
	ExecutionProviders  *[]string               `json:"executionProviders,omitempty"`
}
type ConfigureProvider struct {
	Revision string                `json:"revision"`
	Provider ProviderConfiguration `json:"provider"`
	// Write only. Never returned by the host.
	APIKey string `json:"apiKey,omitempty"`
}

var managementRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)
var connectionMethodID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`)

func validProviderDefinition(d ProviderDefinition) bool {
	text := func(s string, max int) bool { return len(s) > 0 && len(s) <= max }
	if !text(d.Kind, 80) || !text(d.Name, 100) || !text(d.Description, 1000) || !text(d.Protocol, 100) || len(d.Methods) < 1 || len(d.Methods) > 8 || len(d.Requirements) > 2000 || (d.DocsURL != "" && (!strings.HasPrefix(d.DocsURL, "https://") || len(d.DocsURL) > 2000)) {
		return false
	}
	switch d.Category {
	case "native", "api", "compatible", "fixture":
	default:
		return false
	}
	for _, m := range d.Methods {
		if !connectionMethodID.MatchString(m.ID) || !text(m.Label, 100) || !text(m.Description, 1000) {
			return false
		}
		if !connectionMethodID.MatchString(m.Interaction) {
			return false
		}
		switch m.CredentialOwner {
		case "native-runtime", "host", "none":
		default:
			return false
		}
	}
	return true
}

func validManagement(value ManagementSnapshot, id string) bool {
	if value.Version != 1 || !managementRevision.MatchString(value.Revision) || value.Providers == nil || len(value.Providers) > 32 || value.SupportedKinds == nil {
		return false
	}
	if value.ProviderDefinitions != nil {
		if len(*value.ProviderDefinitions) > 32 {
			return false
		}
		for _, definition := range *value.ProviderDefinitions {
			if !validProviderDefinition(definition) {
				return false
			}
		}
	}
	seen := map[string]bool{}
	for _, p := range value.Providers {
		if p.ID == "" || p.Kind == "" || seen[p.ID] {
			return false
		}
		seen[p.ID] = true
	}
	return id == "" || seen[id]
}
func (c *Client) managementRequest(ctx context.Context, path string, body any, id string) (ManagementSnapshot, error) {
	var value ManagementSnapshot
	res, err := c.request(ctx, path, body, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if !validManagement(value, id) {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "The host returned invalid or mismatched provider settings. Refresh before retrying."}
	}
	return value, nil
}
func (c *Client) Management(ctx context.Context) (ManagementSnapshot, error) {
	return c.managementRequest(ctx, "v1/management", nil, "")
}
func (c *Client) ConfigureProvider(ctx context.Context, input ConfigureProvider) (ManagementSnapshot, error) {
	return c.managementRequest(ctx, "v1/management/providers", input, input.Provider.ID)
}
