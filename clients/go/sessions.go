package agenticdriver

import (
	"context"
	"encoding/json"
	"regexp"
	"time"
	"unicode/utf16"
)

type SessionIdentity struct {
	ID string `json:"id"`
}
type SessionHandle struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type SessionCreate struct {
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Mode         string    `json:"mode"`
	History      []Message `json:"history,omitempty"`
	Instructions *string   `json:"instructions,omitempty"`
}
type SessionInfo struct {
	SessionHandle
	Provider  string  `json:"provider"`
	Model     string  `json:"model"`
	Mode      string  `json:"mode"`
	State     string  `json:"state"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	ExpiresAt *string `json:"expiresAt,omitempty"`
}
type SessionSnapshot struct {
	Session      SessionInfo `json:"session"`
	History      []Message   `json:"history"`
	Instructions *string     `json:"instructions,omitempty"`
}
type SessionDeleteResult struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

var sessionDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`)
var sessionID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`)
var sessionProvider = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var sessionModel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`)

// encoding/json matches struct fields without case sensitivity. Decode only
// exact wire keys so additive fields cannot replace an identity or its state.
func exactSessionFields(fields wireObject, names ...string) []byte {
	selected := wireObject{}
	for _, name := range names {
		if raw, present := fields[name]; present {
			selected[name] = raw
		}
	}
	data, _ := json.Marshal(selected)
	return data
}

func invalidSession() error {
	return &Error{Code: "INVALID_RESPONSE", Message: "The conversation response does not match its request."}
}
func (info *SessionInfo) UnmarshalJSON(data []byte) error {
	type plain SessionInfo
	var value plain
	fields, ok := object(data)
	if !ok || json.Unmarshal(exactSessionFields(fields, "id", "revision", "provider", "model", "mode", "state", "createdAt", "updatedAt", "expiresAt"), &value) != nil || !sessionID.MatchString(value.ID) || !numberValue(fields["revision"], false, true) || !sessionProvider.MatchString(value.Provider) || !sessionModel.MatchString(value.Model) || (value.Mode != "history" && value.Mode != "native") {
		return invalidSession()
	}
	created, cErr := time.Parse(time.RFC3339Nano, value.CreatedAt)
	updated, uErr := time.Parse(time.RFC3339Nano, value.UpdatedAt)
	if !sessionDate.MatchString(value.CreatedAt) || !sessionDate.MatchString(value.UpdatedAt) || cErr != nil || uErr != nil || updated.Before(created) {
		return invalidSession()
	}
	if value.State == "running" {
		if _, present := fields["expiresAt"]; present {
			return invalidSession()
		}
	} else {
		if (value.State != "ready" && value.State != "interrupted") || value.ExpiresAt == nil {
			return invalidSession()
		}
		expires, err := time.Parse(time.RFC3339Nano, *value.ExpiresAt)
		if !sessionDate.MatchString(*value.ExpiresAt) || err != nil || !expires.After(updated) {
			return invalidSession()
		}
	}
	*info = SessionInfo(value)
	return nil
}
func (snapshot *SessionSnapshot) UnmarshalJSON(data []byte) error {
	type plain SessionSnapshot
	var value plain
	fields, ok := object(data)
	if !ok || json.Unmarshal(exactSessionFields(fields, "session", "history", "instructions"), &value) != nil {
		return invalidSession()
	}
	var info SessionInfo
	if json.Unmarshal(fields["session"], &info) != nil {
		return invalidSession()
	}
	var messages []json.RawMessage
	if json.Unmarshal(fields["history"], &messages) != nil || messages == nil || len(messages) > 100 {
		return invalidSession()
	}
	for _, raw := range messages {
		message, ok := object(raw)
		role, _ := stringValue(message["role"])
		content, valid := stringValue(message["content"])
		if !ok || len(message) != 2 || (role != "user" && role != "assistant") || !valid || len(utf16.Encode([]rune(content))) > 100000 {
			return invalidSession()
		}
	}
	if raw, present := fields["instructions"]; present {
		content, ok := stringValue(raw)
		if !ok || len(utf16.Encode([]rune(content))) > 100000 {
			return invalidSession()
		}
	}
	*snapshot = SessionSnapshot(value)
	return nil
}
func (result *SessionDeleteResult) UnmarshalJSON(data []byte) error {
	type plain SessionDeleteResult
	fields, ok := object(data)
	var value plain
	if !ok || json.Unmarshal(exactSessionFields(fields, "id", "deleted"), &value) != nil || !sessionID.MatchString(value.ID) || !value.Deleted {
		return invalidSession()
	}
	*result = SessionDeleteResult(value)
	return nil
}
func (c *Client) CreateSession(ctx context.Context, request SessionCreate) (SessionSnapshot, error) {
	var result SessionSnapshot
	res, err := c.request(ctx, "v1/sessions/create", request, false)
	if err != nil {
		return result, err
	}
	if err = decode(res, &result); err != nil {
		return result, err
	}
	info := result.Session
	if info.Provider != request.Provider || info.Model != request.Model || info.Mode != request.Mode || info.State != "ready" || info.Revision != 0 || len(result.History) != len(request.History) || (result.Instructions == nil) != (request.Instructions == nil) {
		return result, invalidSession()
	}
	if result.Instructions != nil && *result.Instructions != *request.Instructions {
		return result, invalidSession()
	}
	for i, message := range result.History {
		if message != request.History[i] {
			return result, invalidSession()
		}
	}
	return result, nil
}
func (c *Client) ReadSession(ctx context.Context, request SessionIdentity) (SessionSnapshot, error) {
	var result SessionSnapshot
	res, err := c.request(ctx, "v1/sessions/read", request, false)
	if err != nil {
		return result, err
	}
	if err = decode(res, &result); err != nil {
		return result, err
	}
	if result.Session.ID != request.ID {
		return result, invalidSession()
	}
	return result, nil
}
func (c *Client) DeleteSession(ctx context.Context, request SessionIdentity) (SessionDeleteResult, error) {
	var result SessionDeleteResult
	res, err := c.request(ctx, "v1/sessions/delete", request, false)
	if err != nil {
		return result, err
	}
	if err = decode(res, &result); err != nil {
		return result, err
	}
	if !result.Deleted || result.ID != request.ID || !sessionID.MatchString(result.ID) {
		return result, invalidSession()
	}
	return result, nil
}
func sessionSelection(result Result, request Request) bool {
	if request.Session == nil {
		return result.Session == nil
	}
	info := result.Session
	return info != nil && info.ID == request.Session.ID && info.Revision == request.Session.Revision+1 && info.Provider == result.Provider && info.Model == result.Model && info.State == "ready"
}
