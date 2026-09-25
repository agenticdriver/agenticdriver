package agenticdriver

import (
	"context"
	"regexp"
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
	InputMediaTypes  map[string][]string `json:"inputMediaTypes,omitempty"`
	ExtensionID      string              `json:"extensionId,omitempty"`
	ExtensionVersion string              `json:"extensionVersion,omitempty"`
	Settings         map[string]any      `json:"settings,omitempty"`
	SecretRefs       map[string]any      `json:"secretRefs,omitempty"`
}
type ManagementSnapshot struct {
	Version            int                     `json:"version"`
	Revision           string                  `json:"revision"`
	Providers          []ProviderConfiguration `json:"providers"`
	SupportedKinds     []string                `json:"supportedKinds"`
	ExecutionProviders *[]string               `json:"executionProviders,omitempty"`
}
type ConfigureProvider struct {
	Revision string                `json:"revision"`
	Provider ProviderConfiguration `json:"provider"`
	// Write only. Never returned by the host.
	APIKey string `json:"apiKey,omitempty"`
}

var managementRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validManagement(value ManagementSnapshot, id string) bool {
	if value.Version != 1 || !managementRevision.MatchString(value.Revision) || value.Providers == nil || len(value.Providers) > 32 || value.SupportedKinds == nil {
		return false
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
