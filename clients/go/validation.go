package agenticdriver

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const maxWireBytes = 2000000
const maxSafeInteger = 9007199254740991

type wireObject map[string]json.RawMessage

func object(data []byte) (wireObject, bool) {
	var value wireObject
	err := json.Unmarshal(data, &value)
	return value, err == nil && value != nil
}
func stringValue(data []byte) (string, bool) {
	var value string
	err := json.Unmarshal(data, &value)
	return value, err == nil && len(data) > 0 && string(data) != "null"
}
func stringField(value wireObject, name string, empty bool) bool {
	text, ok := stringValue(value[name])
	return ok && (empty || text != "")
}
func boolValue(data []byte) bool {
	return bytes.Equal(data, []byte("true")) || bytes.Equal(data, []byte("false"))
}
func numberValue(data []byte, positive, integer bool) bool {
	var value float64
	if json.Unmarshal(data, &value) != nil || len(data) == 0 || bytes.Equal(data, []byte("null")) || math.IsInf(value, 0) || math.IsNaN(value) {
		return false
	}
	return value >= 0 && (!positive || value > 0) && (!integer || (math.Trunc(value) == value && value <= maxSafeInteger))
}
func usageValid(data []byte) bool {
	value, ok := object(data)
	if !ok {
		return false
	}
	for _, name := range []string{"inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd", "apiEquivalentCostUsd"} {
		if raw, present := value[name]; present && !numberValue(raw, false, name != "costUsd" && name != "apiEquivalentCostUsd") {
			return false
		}
	}
	return true
}
func errorValid(data []byte) bool {
	value, ok := object(data)
	if outcome, present := value["outcome"]; present {
		text, _ := stringValue(outcome)
		if text != "uncertain" {
			return false
		}
	}
	return ok && stringField(value, "code", false) && stringField(value, "message", true) && boolValue(value["retryable"])
}

func (failure *Error) UnmarshalJSON(data []byte) error {
	type rawError Error
	var value rawError
	if !utf8.Valid(data) || !errorValid(data) || json.Unmarshal(data, &value) != nil {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned invalid error details."}
	}
	*failure = Error(value)
	return nil
}

func (result *Result) UnmarshalJSON(data []byte) error {
	type rawResult Result
	var decoded rawResult
	value, ok := object(data)
	if raw, present := value["retrieval"]; present && !retrievalValid(raw) {
		return invalidRetrieval()
	}
	if !ok || !contextResultValid(value) || json.Unmarshal(data, &decoded) != nil || !stringField(value, "runId", false) || !stringField(value, "provider", false) || !stringField(value, "model", false) || !stringField(value, "text", true) || !numberValue(value["steps"], true, true) || !usageValid(value["usage"]) || (decoded.FinishReason != "stop" && decoded.FinishReason != "length") {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid run result."}
	}
	*result = Result(decoded)
	if !retrievalLinks(result) {
		return invalidRetrieval()
	}
	return nil
}
func (provider *Provider) UnmarshalJSON(data []byte) error {
	type rawProvider Provider
	var decoded rawProvider
	value, ok := object(data)
	capabilities, capsOK := object(value["capabilities"])
	valid := ok && capsOK && json.Unmarshal(data, &decoded) == nil && stringField(value, "id", false) && stringField(value, "name", false) && stringField(value, "vendor", false) && boolValue(capabilities["tools"]) && boolValue(capabilities["textStreaming"])
	for _, raw := range capabilities {
		valid = valid && boolValue(raw)
	}
	if raw, present := value["models"]; present {
		var models []string
		valid = valid && json.Unmarshal(raw, &models) == nil && models != nil
	}
	if raw, present := value["inputMediaTypes"]; present {
		valid = valid && mediaCatalogValid(raw)
	}
	if raw, present := value["usageStatId"]; present {
		_, ok := stringValue(raw)
		valid = valid && ok
	}
	if raw, present := value["health"]; present {
		h, ok := object(raw)
		status, _ := stringValue(h["status"])
		checked, _ := stringValue(h["checkedAt"])
		_, dateErr := time.Parse(time.RFC3339Nano, checked)
		valid = valid && ok && stringField(h, "code", false) && stringField(h, "message", true) && dateErr == nil &&
			(status == "ready" || status == "unauthenticated" || status == "unavailable" || status == "unsupported" || status == "unknown")
	}
	if raw, present := value["modelCatalog"]; present {
		catalog, ok := object(raw)
		source, _ := stringValue(catalog["source"])
		var models []json.RawMessage
		valid = valid && ok && boolValue(catalog["complete"]) && json.Unmarshal(catalog["models"], &models) == nil && models != nil && len(models) <= 1000 &&
			(source == "provider" || source == "configured" || source == "unavailable")
		for _, model := range models {
			_, isString := stringValue(model)
			valid = valid && isString
		}
	}
	if !valid || (decoded.AuthMode != "none" && decoded.AuthMode != "api-key" && decoded.AuthMode != "cli-session") {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid provider catalog."}
	}
	*provider = Provider(decoded)
	return nil
}

func eventValid(data []byte, event Event, request Request, first bool) bool {
	value, ok := object(data)
	if !ok || !utf8.Valid(data) || !stringField(value, "type", false) || !stringField(value, "runId", false) || !numberValue(value["sequence"], true, true) {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, event.Timestamp); err != nil {
		return false
	}
	if raw, present := value["optional"]; present && !boolValue(raw) {
		return false
	}
	if first != (event.Type == "run.started") {
		return false
	}
	switch event.Type {
	case "tool.execution.requested":
		return executionValid(value["execution"], event, request)
	case "approval.requested":
		return approvalValid(value["approval"]) && event.Approval != nil && event.Approval.RunID == event.RunID && (request.Approvals == nil || event.Approval.IdlePolicy == request.Approvals.IdlePolicy)
	case "approval.resolved":
		return resolutionValid(value["resolution"]) && event.Resolution != nil && event.Resolution.RunID == event.RunID
	case "run.started":
		provider, pOK := stringValue(value["provider"])
		model, mOK := stringValue(value["model"])
		return pOK && mOK && provider == request.Provider && model == request.Model
	case "step.started":
		return numberValue(value["step"], true, true)
	case "text.delta":
		return stringField(value, "text", true)
	case "run.progress":
		phase, _ := stringValue(value["phase"])
		return phase == "model" || phase == "tool" || phase == "context"
	case "tool.called":
		call, valid := object(value["call"])
		_, args := object(call["arguments"])
		return valid && args && stringField(call, "id", false) && stringField(call, "name", false)
	case "tool.completed":
		_, output := value["output"]
		return stringField(value, "callId", false) && output
	case "usage.reported":
		return numberValue(value["step"], true, true) && usageValid(value["usage"])
	case "run.completed":
		return event.Result != nil && event.Result.RunID == event.RunID && event.Result.Provider == request.Provider && event.Result.Model == request.Model && retrievalSelection(event.Result.Retrieval, request.Retrieval)
	case "run.failed", "run.cancelled":
		return errorValid(value["error"])
	default:
		return true
	}
}

// SSE recognizes LF, CRLF and CR, including a CR/LF split across network reads.
func splitSSELines() func([]byte, bool) (int, []byte, error) {
	skipLF := false
	return func(data []byte, eof bool) (int, []byte, error) {
		prefix := 0
		if skipLF && len(data) != 0 {
			skipLF = false
			if data[0] == '\n' {
				// Continue scanning buffered data in this call. A nil token at EOF
				// makes bufio.Scanner stop even if advance leaves more bytes.
				prefix = 1
				data = data[1:]
			}
		}
		if end := bytes.IndexAny(data, "\r\n"); end >= 0 {
			if end > maxWireBytes {
				return 0, nil, &Error{Code: "RESPONSE_TOO_LARGE", Message: "An event exceeded 2 MB."}
			}
			skipLF = data[end] == '\r'
			return prefix + end + 1, data[:end], nil
		}
		if len(data) > maxWireBytes {
			return 0, nil, &Error{Code: "RESPONSE_TOO_LARGE", Message: "An event exceeded 2 MB."}
		}
		if eof && len(data) > 0 {
			return prefix + len(data), data, nil
		}
		return prefix, nil, nil
	}
}

func stripBOM(value string, first *bool) string {
	if !*first {
		return value
	}
	*first = false
	return strings.TrimPrefix(value, "\uFEFF")
}
