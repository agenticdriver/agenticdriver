package agenticdriver

import (
	"context"
	"encoding/json"
)

// IngestionDocument is inline text/Markdown/PDF, an app-resolved reference, or a
// plain-text email thread. References use ID/Revision; other inputs use Source.
// PDF Data is base64. Extractor executables and OCR policy are host configuration.
type IngestionDocument struct {
	Type      string         `json:"type"`
	Source    *ContextSource `json:"source,omitempty"`
	ID        string         `json:"id,omitempty"`
	Revision  string         `json:"revision,omitempty"`
	MediaType string         `json:"mediaType,omitempty"`
	Text      string         `json:"text,omitempty"`
	Data      string         `json:"data,omitempty"`
	ThreadID  string         `json:"threadId,omitempty"`
	Messages  []EmailMessage `json:"messages,omitempty"`
}
type EmailMessage struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}
type ChunkingOptions struct {
	MaxBytes int `json:"maxBytes"`
}
type IngestRequest struct {
	Corpus        string            `json:"corpus"`
	Document      IngestionDocument `json:"document"`
	Chunking      *ChunkingOptions  `json:"chunking,omitempty"`
	IdleTimeoutMs *int              `json:"idleTimeoutMs,omitempty"`
}
type ExtractionIdentity struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}
type ChunkerInfo struct {
	ID       string `json:"id"`
	MaxBytes int    `json:"maxBytes"`
}
type PageCoverage struct {
	Total int   `json:"total"`
	OCR   []int `json:"ocr"`
	Empty []int `json:"empty"`
}
type MessageCoverage struct {
	Total int `json:"total"`
	Empty int `json:"empty"`
}
type IngestionManifest struct {
	Format             string              `json:"format"`
	InputSHA256        string              `json:"inputSha256"`
	InputBytes         int                 `json:"inputBytes"`
	Extractor          ExtractionIdentity  `json:"extractor"`
	OCRExtractor       *ExtractionIdentity `json:"ocrExtractor,omitempty"`
	Chunker            ChunkerInfo         `json:"chunker"`
	ExtractedTextBytes int                 `json:"extractedTextBytes"`
	IndexedTextBytes   int                 `json:"indexedTextBytes"`
	Chunks             int                 `json:"chunks"`
	Pages              *PageCoverage       `json:"pages,omitempty"`
	Messages           *MessageCoverage    `json:"messages,omitempty"`
}

// IngestContext always requires a validated, non-nil Ingestion manifest.
type IngestResult = RetrievalIndexResult

func ingestionFields(value wireObject, required, optional []string) bool {
	for _, key := range required {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	for key := range value {
		found := false
		for _, allowed := range append(append([]string{}, required...), optional...) {
			if key == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func ingestionInteger(raw json.RawMessage, low, high int) bool {
	var n int
	return string(raw) != "null" && json.Unmarshal(raw, &n) == nil && n >= low && n <= high
}
func extractionIdentityValid(raw json.RawMessage) bool {
	value, ok := object(raw)
	return ok && ingestionFields(value, []string{"id", "version"}, nil) && matches(value["id"], sourceIDPattern) && boundedText(value["version"], 128, false)
}
func ingestionValid(raw json.RawMessage) bool {
	value, ok := object(raw)
	if !ok || !ingestionFields(value, []string{"format", "inputSha256", "inputBytes", "extractor", "chunker", "extractedTextBytes", "indexedTextBytes", "chunks"}, []string{"ocrExtractor", "pages", "messages"}) ||
		!matches(value["inputSha256"], digestPattern) || !ingestionInteger(value["inputBytes"], 1, 33554432) || !extractionIdentityValid(value["extractor"]) ||
		!ingestionInteger(value["extractedTextBytes"], 1, 1048576) || !ingestionInteger(value["chunks"], 1, 256) {
		return false
	}
	var extracted int
	_ = json.Unmarshal(value["extractedTextBytes"], &extracted)
	if !ingestionInteger(value["indexedTextBytes"], 1, extracted) {
		return false
	}
	format, _ := stringValue(value["format"])
	if format != "text" && format != "markdown" && format != "pdf" && format != "email" {
		return false
	}
	chunker, ok := object(value["chunker"])
	if !ok || !ingestionFields(chunker, []string{"id", "maxBytes"}, nil) || string(chunker["id"]) != `"source-lines-v1"` || !ingestionInteger(chunker["maxBytes"], 128, 16384) {
		return false
	}
	_, hasPages := value["pages"]
	_, hasOCR := value["ocrExtractor"]
	if format == "pdf" {
		pages, ok := object(value["pages"])
		if !ok || !ingestionFields(pages, []string{"total", "ocr", "empty"}, nil) || !ingestionInteger(pages["total"], 1, 1000) {
			return false
		}
		var total int
		_ = json.Unmarshal(pages["total"], &total)
		ocrCount, emptyCount := 0, 0
		for _, key := range []string{"ocr", "empty"} {
			var entries []json.RawMessage
			if json.Unmarshal(pages[key], &entries) != nil || entries == nil || len(entries) > 1000 {
				return false
			}
			used := map[int]bool{}
			for _, raw := range entries {
				if !ingestionInteger(raw, 1, total) {
					return false
				}
				var n int
				_ = json.Unmarshal(raw, &n)
				if used[n] {
					return false
				}
				used[n] = true
			}
			if key == "ocr" {
				ocrCount = len(entries)
			} else {
				emptyCount = len(entries)
			}
		}
		var chunks int
		_ = json.Unmarshal(value["chunks"], &chunks)
		if emptyCount >= total || chunks < total-emptyCount {
			return false
		}
		if hasOCR != (ocrCount > 0) || (hasOCR && !extractionIdentityValid(value["ocrExtractor"])) {
			return false
		}
	} else if hasPages || hasOCR {
		return false
	}
	_, hasMessages := value["messages"]
	if format == "email" {
		messages, ok := object(value["messages"])
		if !ok || !ingestionFields(messages, []string{"total", "empty"}, nil) || !ingestionInteger(messages["total"], 1, 1000) {
			return false
		}
		var total int
		_ = json.Unmarshal(messages["total"], &total)
		var chunks, empty int
		_ = json.Unmarshal(value["chunks"], &chunks)
		_ = json.Unmarshal(messages["empty"], &empty)
		if !ingestionInteger(messages["empty"], 0, total-1) || chunks < total-empty {
			return false
		}
	} else if hasMessages {
		return false
	}
	return true
}
func (c *Client) IngestContext(ctx context.Context, request IngestRequest) (*IngestResult, error) {
	response, err := c.request(ctx, "v1/retrieval/ingest", request, false)
	if err != nil {
		return nil, err
	}
	var raw wireObject
	if err = decode(response, &raw); err != nil {
		return nil, err
	}
	source := ContextSource{ID: request.Document.ID, Revision: request.Document.Revision}
	if request.Document.Type != "reference" {
		if request.Document.Source == nil {
			return nil, invalidRetrieval()
		}
		source = *request.Document.Source
	}
	if !ingestionValid(raw["ingestion"]) {
		return nil, invalidRetrieval()
	}
	return indexReceipt(raw, request.Corpus, source)
}
