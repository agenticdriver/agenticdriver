package agenticdriver

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// ContextInput is either an inline text/image/PDF payload or an app-authorized reference.
// References set ID and Revision; inline payloads set Source and Text or base64 Data.
// No client-side file or URL is fetched implicitly.
type ContextInput struct {
	Type      string         `json:"type"`
	Source    *ContextSource `json:"source,omitempty"`
	ID        string         `json:"id,omitempty"`
	Revision  string         `json:"revision,omitempty"`
	MediaType string         `json:"mediaType"`
	Text      string         `json:"text,omitempty"`
	Data      string         `json:"data,omitempty"`
}
type ContextSource struct {
	ID       string          `json:"id"`
	Revision string          `json:"revision"`
	Title    string          `json:"title,omitempty"`
	URI      string          `json:"uri,omitempty"`
	Location *SourceLocation `json:"location,omitempty"`
}
type SourceLocation struct {
	DocumentID string `json:"documentId,omitempty"`
	Page       *int   `json:"page,omitempty"`
	PageEnd    *int   `json:"pageEnd,omitempty"`
	StartLine  *int   `json:"startLine,omitempty"`
	EndLine    *int   `json:"endLine,omitempty"`
	Section    string `json:"section,omitempty"`
	ThreadID   string `json:"threadId,omitempty"`
	MessageID  string `json:"messageId,omitempty"`
}
type ContextManifest struct {
	ContextSource
	MediaType string `json:"mediaType"`
	Bytes     int    `json:"bytes"`
	SHA256    string `json:"sha256"`
	Origin    string `json:"origin"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}
type ArtifactRequest struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
}
type DraftArtifact struct {
	ArtifactRequest
	ID        string   `json:"id"`
	Status    string   `json:"status"`
	Content   string   `json:"content"`
	SHA256    string   `json:"sha256"`
	SourceIDs []string `json:"sourceIds"`
}

var sourceIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var artifactIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var uriPattern = regexp.MustCompile(`^(https|app)://[^\s]+$`)

func boundedText(data []byte, max int, empty bool) bool {
	value, ok := stringValue(data)
	return ok && (empty || value != "") && len(utf16.Encode([]rune(value))) <= max
}
func matches(data []byte, pattern *regexp.Regexp) bool {
	value, ok := stringValue(data)
	return ok && pattern.MatchString(value)
}
func mediaValid(value string) bool {
	switch value {
	case "text/plain", "text/markdown", "image/png", "image/jpeg", "image/webp", "application/pdf":
		return true
	}
	return false
}
func mediaCatalogValid(data []byte) bool {
	value, ok := object(data)
	if !ok {
		return false
	}
	for _, raw := range value {
		var media []json.RawMessage
		if json.Unmarshal(raw, &media) != nil || media == nil || len(media) > 6 {
			return false
		}
		for _, entry := range media {
			text, ok := stringValue(entry)
			if !ok || !mediaValid(text) {
				return false
			}
		}
	}
	return true
}
func sourceValid(data []byte) bool {
	value, ok := object(data)
	if !ok || !matches(value["id"], sourceIDPattern) || !matches(value["revision"], sourceIDPattern) || !matches(value["sha256"], digestPattern) {
		return false
	}
	media, _ := stringValue(value["mediaType"])
	origin, _ := stringValue(value["origin"])
	if !mediaValid(media) || (origin != "inline" && origin != "reference" && origin != "retrieval") || !numberValue(value["bytes"], true, true) {
		return false
	}
	var size float64
	_ = json.Unmarshal(value["bytes"], &size)
	if size > 33554432 {
		return false
	}
	if raw, present := value["title"]; present && !boundedText(raw, 256, true) {
		return false
	}
	if raw, present := value["uri"]; present {
		if !boundedText(raw, 2048, false) || !matches(raw, uriPattern) {
			return false
		}
		text, _ := stringValue(raw)
		uri, err := url.Parse(text)
		if err != nil || uri.User != nil {
			return false
		}
	}
	if raw, present := value["expiresAt"]; present {
		text, ok := stringValue(raw)
		_, err := time.Parse(time.RFC3339Nano, text)
		if !ok || err != nil {
			return false
		}
	}
	if raw, present := value["location"]; present {
		location, ok := object(raw)
		if !ok {
			return false
		}
		for _, key := range []string{"documentId", "threadId", "messageId"} {
			if data, exists := location[key]; exists && !matches(data, sourceIDPattern) {
				return false
			}
		}
		if data, exists := location["section"]; exists && !boundedText(data, 256, true) {
			return false
		}
		for _, key := range []string{"page", "pageEnd", "startLine", "endLine"} {
			if data, exists := location[key]; exists {
				var n float64
				if !numberValue(data, true, true) || json.Unmarshal(data, &n) != nil || n > 1000000 {
					return false
				}
			}
		}
		for _, pair := range [][2]string{{"page", "pageEnd"}, {"startLine", "endLine"}} {
			if raw, exists := location[pair[1]]; exists {
				var start, end float64
				_ = json.Unmarshal(raw, &end)
				if json.Unmarshal(location[pair[0]], &start) != nil || start == 0 || end < start {
					return false
				}
			}
		}
	}
	return true
}
func contextResultValid(value wireObject) bool {
	ids := map[string]bool{}
	if raw, present := value["sources"]; present {
		var sources []json.RawMessage
		if json.Unmarshal(raw, &sources) != nil || sources == nil || len(sources) > 16 {
			return false
		}
		for _, raw := range sources {
			if !sourceValid(raw) {
				return false
			}
			source, _ := object(raw)
			id, _ := stringValue(source["id"])
			if ids[id] {
				return false
			}
			ids[id] = true
		}
	}
	if raw, present := value["artifacts"]; present {
		var artifacts []json.RawMessage
		if json.Unmarshal(raw, &artifacts) != nil || artifacts == nil || len(artifacts) > 1 {
			return false
		}
		for _, raw := range artifacts {
			artifact, ok := object(raw)
			if !ok || !boundedText(artifact["name"], 128, false) || !boundedText(artifact["content"], 262144, true) || !matches(artifact["id"], artifactIDPattern) || !matches(artifact["sha256"], digestPattern) {
				return false
			}
			name, _ := stringValue(artifact["name"])
			if name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
				return false
			}
			for _, r := range name {
				if r < 32 {
					return false
				}
			}
			status, _ := stringValue(artifact["status"])
			media, _ := stringValue(artifact["mediaType"])
			if status != "draft" || (media != "text/plain" && media != "text/markdown" && media != "application/json") {
				return false
			}
			var refs []json.RawMessage
			if json.Unmarshal(artifact["sourceIds"], &refs) != nil || refs == nil || len(refs) > 16 {
				return false
			}
			used := map[string]bool{}
			for _, raw := range refs {
				id, ok := stringValue(raw)
				if !ok || !ids[id] || used[id] {
					return false
				}
				used[id] = true
			}
		}
	}
	return true
}
