package agenticdriver

import (
	"context"
	"regexp"
	"time"
)

// ProviderSetupConfig always creates a new host-owned profile. It cannot name a shared directory.
type ProviderSetupConfig struct {
	Kind             string    `json:"kind"`
	ID               string    `json:"id"`
	AccountID        string    `json:"accountId"`
	Name             string    `json:"name,omitempty"`
	Binary           string    `json:"binary,omitempty"`
	Enabled          *bool     `json:"enabled,omitempty"`
	Models           *[]string `json:"models,omitempty"`
	ReasoningEffort  string    `json:"reasoningEffort,omitempty"`
	ApplicationTools string    `json:"applicationTools,omitempty"`
}
type ProviderSetupRequest struct {
	Action   string               `json:"action"`
	ID       string               `json:"id,omitempty"`
	Revision string               `json:"revision,omitempty"`
	Method   string               `json:"method,omitempty"`
	Provider *ProviderSetupConfig `json:"provider,omitempty"`
}
type ProviderSetupInteraction struct {
	Type            string `json:"type"`
	VerificationURL string `json:"verificationUrl"`
	UserCode        string `json:"userCode"`
}
type ProviderSetupAccount struct {
	Email             *string `json:"email"`
	Plan              string  `json:"plan"`
	ProviderAccountID string  `json:"providerAccountId,omitempty"`
}
type ProviderSetupError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ProviderSetupAttempt struct {
	ID          string                    `json:"id"`
	ProviderID  string                    `json:"providerId"`
	AccountID   string                    `json:"accountId"`
	Name        string                    `json:"name"`
	Revision    string                    `json:"revision"`
	Method      string                    `json:"method"`
	Phase       string                    `json:"phase"`
	CreatedAt   string                    `json:"createdAt"`
	UpdatedAt   string                    `json:"updatedAt"`
	ExpiresAt   string                    `json:"expiresAt"`
	Interaction *ProviderSetupInteraction `json:"interaction,omitempty"`
	Account     *ProviderSetupAccount     `json:"account,omitempty"`
	Error       *ProviderSetupError       `json:"error,omitempty"`
}
type ProviderSetupSnapshot struct {
	Version  int                    `json:"version"`
	Attempts []ProviderSetupAttempt `json:"attempts"`
}

var setupUUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$`)
var setupInstance = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var setupCode = regexp.MustCompile(`^[A-Z0-9-]{4,40}$`)

func validSetupRequest(r ProviderSetupRequest) bool {
	switch r.Action {
	case "list":
		return r.ID == "" && r.Provider == nil && r.Revision == "" && r.Method == ""
	case "status", "accept", "cancel":
		return setupUUID.MatchString(r.ID) && r.Provider == nil && r.Revision == "" && r.Method == ""
	case "start":
		p := r.Provider
		return r.ID == "" && r.Method == "codex-device" && managementRevision.MatchString(r.Revision) && p != nil && p.Kind == "codex" && setupInstance.MatchString(p.ID) && setupInstance.MatchString(p.AccountID) && len(p.Name) <= 100 && len(p.Binary) <= 4096 && (p.Models == nil || len(*p.Models) <= 1000) && (p.ApplicationTools == "" || p.ApplicationTools == "mcp")
	}
	return false
}
func validSetupSnapshot(s ProviderSetupSnapshot, r ProviderSetupRequest) bool {
	if s.Version != 1 || s.Attempts == nil || len(s.Attempts) > 32 {
		return false
	}
	ids := map[string]bool{}
	for _, a := range s.Attempts {
		if !setupUUID.MatchString(a.ID) || ids[a.ID] || !setupInstance.MatchString(a.ProviderID) || !setupInstance.MatchString(a.AccountID) || a.Name == "" || len(a.Name) > 100 || !managementRevision.MatchString(a.Revision) || a.Method != "codex-device" {
			return false
		}
		ids[a.ID] = true
		switch a.Phase {
		case "starting", "waiting", "verifying", "ready", "succeeded", "failed", "cancelled", "expired":
		default:
			return false
		}
		for _, stamp := range []string{a.CreatedAt, a.UpdatedAt, a.ExpiresAt} {
			if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
				return false
			}
		}
		if i := a.Interaction; i != nil && (i.Type != "device-code" || i.VerificationURL != "https://auth.openai.com/codex/device" || !setupCode.MatchString(i.UserCode)) {
			return false
		}
		if account := a.Account; account != nil && (account.Plan == "" || len(account.Plan) > 80 || len(account.ProviderAccountID) > 256 || account.Email != nil && len(*account.Email) > 320) {
			return false
		}
		if e := a.Error; e != nil && (e.Code == "" || len(e.Code) > 80 || e.Message == "" || len(e.Message) > 512) {
			return false
		}
	}
	if r.Action == "list" {
		return true
	}
	if len(s.Attempts) != 1 {
		return false
	}
	a := s.Attempts[0]
	if r.Action == "start" {
		return r.Provider != nil && a.ProviderID == r.Provider.ID && a.AccountID == r.Provider.AccountID && a.Revision == r.Revision && a.Method == r.Method
	}
	return a.ID == r.ID
}

// ProviderSetup makes exactly one setup request. It never starts a model or retries a sign-in.
func (c *Client) ProviderSetup(ctx context.Context, input ProviderSetupRequest) (ProviderSetupSnapshot, error) {
	var value ProviderSetupSnapshot
	if !validSetupRequest(input) {
		return value, &Error{Code: "INVALID_SETUP_REQUEST", Message: "Choose a supported provider setup operation."}
	}
	res, err := c.request(ctx, "v1/management/setup", input, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if !validSetupSnapshot(value, input) {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "The host returned invalid or mismatched provider setup state."}
	}
	return value, nil
}
