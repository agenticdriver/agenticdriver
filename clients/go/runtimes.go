package agenticdriver

import (
	"context"
	"time"
)

// Runtime versions, sources and paths are selected by the host, never this request.
type ProviderRuntimeRequest struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	ID     string `json:"id,omitempty"`
}
type ProviderRuntimeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ProviderRuntimeInfo struct {
	Kind          string                `json:"kind"`
	Version       string                `json:"version"`
	Platform      string                `json:"platform"`
	Phase         string                `json:"phase"`
	ArchiveSha256 string                `json:"archiveSha256"`
	DownloadBytes *int64                `json:"downloadBytes"`
	TotalBytes    *int64                `json:"totalBytes"`
	CanCancel     *bool                 `json:"canCancel"`
	ID            string                `json:"id,omitempty"`
	UpdatedAt     string                `json:"updatedAt,omitempty"`
	Binary        string                `json:"binary,omitempty"`
	Error         *ProviderRuntimeError `json:"error,omitempty"`
}
type ProviderRuntimeSnapshot struct {
	Version  int                   `json:"version"`
	Runtimes []ProviderRuntimeInfo `json:"runtimes"`
}

func validRuntimeRequest(r ProviderRuntimeRequest) bool {
	if r.Kind != "codex" {
		return false
	}
	switch r.Action {
	case "status", "install":
		return r.ID == ""
	case "cancel":
		return setupUUID.MatchString(r.ID)
	}
	return false
}
func validRuntimeSnapshot(s ProviderRuntimeSnapshot, request ProviderRuntimeRequest) bool {
	if s.Version != 1 || len(s.Runtimes) != 1 {
		return false
	}
	r := s.Runtimes[0]
	if r.Kind != request.Kind || r.Version != "0.157.0" || r.Platform != "linux-x64" || !managementRevision.MatchString(r.ArchiveSha256) || r.CanCancel == nil || r.DownloadBytes == nil || r.TotalBytes == nil || *r.DownloadBytes < 0 || *r.TotalBytes <= 0 || *r.TotalBytes > 9007199254740991 || *r.DownloadBytes > *r.TotalBytes {
		return false
	}
	switch r.Phase {
	case "missing", "downloading", "verifying", "installed", "failed", "cancelled":
	default:
		return false
	}
	active := r.Phase == "downloading" || r.Phase == "verifying"
	if (r.Phase == "installed" || r.Phase == "verifying") && *r.DownloadBytes != *r.TotalBytes {
		return false
	}
	if r.ID != "" && !setupUUID.MatchString(r.ID) || active && r.ID == "" || *r.CanCancel && !active || len(r.Binary) > 4096 || (r.Phase == "installed") != (r.Binary != "") || request.Action == "cancel" && r.ID != request.ID {
		return false
	}
	if r.UpdatedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, r.UpdatedAt); err != nil {
			return false
		}
	}
	if e := r.Error; e != nil && (e.Code == "" || len(e.Code) > 80 || e.Message == "" || len(e.Message) > 512) {
		return false
	}
	return true
}

// ProviderRuntime schedules one explicit installation or reads/cancels it. It never retries or starts a model.
func (c *Client) ProviderRuntime(ctx context.Context, input ProviderRuntimeRequest) (ProviderRuntimeSnapshot, error) {
	var value ProviderRuntimeSnapshot
	if !validRuntimeRequest(input) {
		return value, &Error{Code: "INVALID_RUNTIME_REQUEST", Message: "Choose a supported runtime operation."}
	}
	res, err := c.request(ctx, "v1/management/runtimes", input, false)
	if err != nil {
		return value, err
	}
	if err = decode(res, &value); err != nil {
		return value, err
	}
	if !validRuntimeSnapshot(value, input) {
		return value, &Error{Code: "INVALID_RESPONSE", Message: "The host returned invalid or mismatched runtime state."}
	}
	return value, nil
}
