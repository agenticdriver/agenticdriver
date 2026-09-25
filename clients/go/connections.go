package agenticdriver

import (
	"context"
	"encoding/base64"
	"regexp"
	"strings"
	"time"
)

type ConnectionGrant struct {
	Subject          string              `json:"subject"`
	Providers        []string            `json:"providers"`
	ManageProviders  bool                `json:"manageProviders,omitempty"`
	Tools            []string            `json:"tools,omitempty"`
	ApproveTools     []string            `json:"approveTools,omitempty"`
	ApplicationTools []map[string]any    `json:"applicationTools,omitempty"`
	Jobs             []string            `json:"jobs,omitempty"`
	Sessions         []string            `json:"sessions,omitempty"`
	Retrieval        map[string][]string `json:"retrieval,omitempty"`
}
type CreateInvitation struct {
	Grant                     ConnectionGrant `json:"grant"`
	ExpiresInSeconds          int             `json:"expiresInSeconds,omitempty"`
	ConnectionLifetimeSeconds int             `json:"connectionLifetimeSeconds,omitempty"`
}
type ConnectionInfo struct {
	ID        string          `json:"id"`
	Grant     ConnectionGrant `json:"grant"`
	CreatedAt string          `json:"createdAt"`
	ExpiresAt string          `json:"expiresAt"`
}
type ConnectionInvitation struct {
	ConnectionInfo
	Code string `json:"code"`
}
type ConnectionCredentials struct {
	ConnectionInfo
	Token string `json:"token"`
}
type ConnectionList struct {
	Invitations []ConnectionInfo `json:"invitations"`
	Connections []ConnectionInfo `json:"connections"`
}
type ConnectionTarget struct {
	URL  string
	Code string
}

var invitationCode = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func ParseConnectionInvitation(invitation string) (ConnectionTarget, error) {
	parts := strings.Split(strings.TrimSpace(invitation), ".")
	invalid := &Error{Code: "INVALID_INVITATION", Message: "Use a complete invitation from the selected AgenticDriver host."}
	if len(parts) != 3 || parts[0] != "ad1" || len(parts[1]) > 8192 || !invitationCode.MatchString(parts[2]) {
		return ConnectionTarget{}, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ConnectionTarget{}, invalid
	}
	client, err := New(string(raw), parts[2])
	if err != nil {
		return ConnectionTarget{}, invalid
	}
	return ConnectionTarget{URL: client.base, Code: parts[2]}, nil
}
func validConnection(info ConnectionInfo) bool {
	_, start := time.Parse(time.RFC3339Nano, info.CreatedAt)
	_, expiry := time.Parse(time.RFC3339Nano, info.ExpiresAt)
	return len(info.ID) == 36 && info.Grant.Subject != "" && info.Grant.Providers != nil && start == nil && expiry == nil
}
func (c *Client) CreateInvitation(ctx context.Context, input CreateInvitation) (ConnectionInvitation, error) {
	var value ConnectionInvitation
	res, err := c.request(ctx, "v1/management/invitations", input, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if !validConnection(value.ConnectionInfo) || !invitationCode.MatchString(value.Code) {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "Invalid connection invitation."}
	}
	return value, nil
}

// ExchangeConnection uses this client's token as the one-use invitation code.
func (c *Client) ExchangeConnection(ctx context.Context) (ConnectionCredentials, error) {
	var value ConnectionCredentials
	res, err := c.request(ctx, "v1/connections/exchange", struct{}{}, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if !validConnection(value.ConnectionInfo) || !invitationCode.MatchString(value.Token) {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "Invalid connection credential. Reconcile before retrying."}
	}
	return value, nil
}
func (c *Client) Connections(ctx context.Context) (ConnectionList, error) {
	var value ConnectionList
	res, err := c.request(ctx, "v1/management/connections", nil, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if value.Invitations == nil || value.Connections == nil || len(value.Invitations) > 1000 || len(value.Connections) > 1000 {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "Invalid connection list."}
	}
	for _, info := range append(append([]ConnectionInfo{}, value.Invitations...), value.Connections...) {
		if !validConnection(info) {
			return value, &Error{Code: "INVALID_RESPONSE", Message: "Invalid connection metadata."}
		}
	}
	return value, nil
}
func (c *Client) RevokeConnection(ctx context.Context, id string) (bool, error) {
	res, err := c.request(ctx, "v1/management/connections/revoke", map[string]string{"id": id}, false)
	if err != nil {
		return false, err
	}
	var value struct {
		Revoked *bool `json:"revoked"`
	}
	if err = decode(res, &value); err != nil {
		return false, err
	}
	if value.Revoked == nil {
		return false, &Error{Code: "INVALID_RESPONSE", Message: "Invalid revocation receipt."}
	}
	return *value.Revoked, nil
}
