package agenticdriver

import (
	"context"
	"encoding/json"
	"unicode/utf16"
)

type ApplicationToolDefinition struct {
	Name             string         `json:"name"`
	Description      string         `json:"description"`
	InputSchema      map[string]any `json:"inputSchema"`
	OutputSchema     map[string]any `json:"outputSchema,omitempty"`
	RequiresApproval bool           `json:"requiresApproval,omitempty"`
}
type ToolExecutionIdentity struct {
	ExecutionID string `json:"executionId"`
	RunID       string `json:"runId"`
	CallID      string `json:"callId"`
}
type ToolExecutionRequest struct {
	ExecutionID string   `json:"executionId"`
	RunID       string   `json:"runId"`
	Call        ToolCall `json:"call"`
}

func (execution ToolExecutionRequest) Identity() ToolExecutionIdentity {
	return ToolExecutionIdentity{ExecutionID: execution.ExecutionID, RunID: execution.RunID, CallID: execution.Call.ID}
}

type ToolExecutionResult struct {
	ToolExecutionIdentity
	// Use json.RawMessage("null") to return a JSON null. Do not set both Output and Error.
	Output json.RawMessage `json:"output,omitempty"`
	// Only "APPLICATION_TOOL_FAILED" is accepted; never send exception text or secrets.
	Error string `json:"error,omitempty"`
}
type ToolExecutionReceipt struct {
	ToolExecutionIdentity
	Status string `json:"status"`
}

func (c *Client) ReportToolProgress(ctx context.Context, identity ToolExecutionIdentity) (ToolExecutionReceipt, error) {
	return c.toolRequest(ctx, "progress", identity, identity, "progress")
}
func (c *Client) CompleteTool(ctx context.Context, result ToolExecutionResult) (ToolExecutionReceipt, error) {
	return c.toolRequest(ctx, "results", result, result.ToolExecutionIdentity, "accepted")
}
func (c *Client) toolRequest(ctx context.Context, path string, body any, identity ToolExecutionIdentity, status string) (ToolExecutionReceipt, error) {
	var receipt ToolExecutionReceipt
	res, err := c.request(ctx, "v1/tool-executions/"+path, body, false)
	if err != nil {
		return receipt, err
	}
	if err = decode(res, &receipt); err != nil {
		return receipt, err
	}
	if receipt.ToolExecutionIdentity != identity || receipt.Status != status {
		return receipt, &Error{Code: "INVALID_RESPONSE", Message: "The tool receipt does not match its submission; reconcile the originating run."}
	}
	return receipt, nil
}
func (receipt *ToolExecutionReceipt) UnmarshalJSON(data []byte) error {
	type plain ToolExecutionReceipt
	var decoded plain
	value, ok := object(data)
	if !ok || !stringField(value, "executionId", false) || !stringField(value, "runId", false) || !stringField(value, "callId", false) || json.Unmarshal(data, &decoded) != nil || (decoded.Status != "accepted" && decoded.Status != "progress") || !boundedExecutionID(decoded.ExecutionID) || !boundedExecutionID(decoded.RunID) || !boundedExecutionID(decoded.CallID) {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid tool execution receipt."}
	}
	*receipt = ToolExecutionReceipt(decoded)
	return nil
}
func boundedExecutionID(value string) bool {
	return value != "" && len(utf16.Encode([]rune(value))) <= 256
}
func executionValid(data json.RawMessage, event Event, request Request) bool {
	value, ok := object(data)
	if !ok || !stringField(value, "executionId", false) || !stringField(value, "runId", false) || event.Execution == nil || event.Execution.RunID != event.RunID || !boundedExecutionID(event.Execution.ExecutionID) || !boundedExecutionID(event.Execution.RunID) || !boundedExecutionID(event.Execution.Call.ID) {
		return false
	}
	call, ok := object(value["call"])
	_, args := object(call["arguments"])
	if !ok || !args || !stringField(call, "id", false) || !approvalToolName.MatchString(event.Execution.Call.Name) {
		return false
	}
	if len(request.ApplicationTools) == 0 {
		return true
	}
	declared, selected := false, false
	for _, definition := range request.ApplicationTools {
		declared = declared || definition.Name == event.Execution.Call.Name
	}
	for _, name := range request.Tools {
		selected = selected || name == event.Execution.Call.Name
	}
	return declared && selected
}
