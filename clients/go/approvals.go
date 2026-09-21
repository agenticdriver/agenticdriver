package agenticdriver

import (
	"context"
	"encoding/json"
	"regexp"
	"time"
)

// ApprovalPolicy explicitly negotiates interactive decisions. Expiry is absent by default.
type ApprovalPolicy struct {
	Mode           string `json:"mode"`
	IdlePolicy     string `json:"idlePolicy"`
	ExpiresAfterMs *int   `json:"expiresAfterMs,omitempty"`
}
type ApprovalRequest struct {
	ApprovalID  string   `json:"approvalId"`
	RunID       string   `json:"runId"`
	Call        ToolCall `json:"call"`
	RequestedAt string   `json:"requestedAt"`
	ExpiresAt   *string  `json:"expiresAt,omitempty"`
	IdlePolicy  string   `json:"idlePolicy"`
}
type ApprovalDecision struct {
	ApprovalID string   `json:"approvalId"`
	RunID      string   `json:"runId"`
	Call       ToolCall `json:"call"`
	Decision   string   `json:"decision"`
}
type ApprovalResolution struct {
	ApprovalID string `json:"approvalId"`
	RunID      string `json:"runId"`
	CallID     string `json:"callId"`
	Outcome    string `json:"outcome"`
	DecidedAt  string `json:"decidedAt"`
}

// DecideApproval consumes a pending approval once. A receipt is not confirmation of a tool effect.
// Lost responses are reconciled against the run stream; this method never retries.
func (c *Client) DecideApproval(ctx context.Context, decision ApprovalDecision) (ApprovalResolution, error) {
	var result ApprovalResolution
	res, err := c.request(ctx, "v1/approvals/decisions", decision, false)
	if err != nil {
		return result, err
	}
	if err = decode(res, &result); err != nil {
		return result, err
	}
	expected := map[string]string{"approve": "approved", "deny": "denied", "cancel": "cancelled"}[decision.Decision]
	if result.ApprovalID != decision.ApprovalID || result.RunID != decision.RunID || result.CallID != decision.Call.ID || result.Outcome != expected {
		return result, &Error{Code: "INVALID_RESPONSE", Message: "The approval receipt does not match the decision; reconcile using the run stream."}
	}
	return result, nil
}
func timestampField(value map[string]json.RawMessage, key string) bool {
	text, ok := stringValue(value[key])
	_, err := time.Parse(time.RFC3339Nano, text)
	return ok && err == nil
}

var approvalToolName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`)

func approvalValid(data json.RawMessage) bool {
	value, ok := object(data)
	if !ok || !stringField(value, "approvalId", false) || !stringField(value, "runId", false) || !timestampField(value, "requestedAt") {
		return false
	}
	if _, exists := value["expiresAt"]; exists && !timestampField(value, "expiresAt") {
		return false
	}
	idle, _ := stringValue(value["idlePolicy"])
	call, ok := object(value["call"])
	name, _ := stringValue(call["name"])
	id, _ := stringValue(call["id"])
	_, args := object(call["arguments"])
	return (idle == "pause" || idle == "continue") && ok && args && len(id) > 0 && len([]rune(id)) <= 256 && approvalToolName.MatchString(name)
}
func resolutionValid(data json.RawMessage) bool {
	value, ok := object(data)
	outcome, _ := stringValue(value["outcome"])
	return ok && stringField(value, "approvalId", false) && stringField(value, "runId", false) && stringField(value, "callId", false) && timestampField(value, "decidedAt") &&
		(outcome == "approved" || outcome == "denied" || outcome == "cancelled" || outcome == "expired")
}
func (resolution *ApprovalResolution) UnmarshalJSON(data []byte) error {
	type plain ApprovalResolution
	var value plain
	if !resolutionValid(data) || json.Unmarshal(data, &value) != nil {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid approval resolution."}
	}
	*resolution = ApprovalResolution(value)
	return nil
}
