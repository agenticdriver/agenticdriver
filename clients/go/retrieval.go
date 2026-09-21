package agenticdriver

import (
	"context"
	"encoding/json"
	"math"
	"regexp"
)

type RetrievalRequest struct {
	Corpus          string   `json:"corpus"`
	SourceIDs       []string `json:"sourceIds,omitempty"`
	Query           string   `json:"query,omitempty"`
	Limit           int      `json:"limit,omitempty"`
	MaxContextBytes int      `json:"maxContextBytes,omitempty"`
	MinScore        *float64 `json:"minScore,omitempty"`
}

// SearchContext requires Query. A run defaults an omitted query to its input.
type RetrievalSearch = RetrievalRequest
type VectorIndex struct {
	ProviderID string `json:"providerId"`
	Vendor     string `json:"vendor"`
	AccountID  string `json:"accountId"`
	AuthMode   string `json:"authMode"`
	Model      string `json:"model"`
	Dimensions int    `json:"dimensions"`
	Metric     string `json:"metric"`
	Version    string `json:"version"`
}
type RetrievalChunk struct {
	ID       string          `json:"id"`
	Text     string          `json:"text"`
	Location *SourceLocation `json:"location,omitempty"`
}
type RetrievalIndexRequest struct {
	Corpus string           `json:"corpus"`
	Source ContextSource    `json:"source"`
	Chunks []RetrievalChunk `json:"chunks"`
}
type RetrievalHit struct {
	ChunkID        string        `json:"chunkId"`
	Source         ContextSource `json:"source"`
	Text           string        `json:"text"`
	Score          float64       `json:"score"`
	DocumentSHA256 string        `json:"documentSha256"`
}
type RetrievalResult struct {
	Corpus    string         `json:"corpus"`
	Index     VectorIndex    `json:"index"`
	Hits      []RetrievalHit `json:"hits"`
	Truncated bool           `json:"truncated"`
}
type RetrievalIndexResult struct {
	Corpus         string `json:"corpus"`
	SourceID       string `json:"sourceId"`
	Revision       string `json:"revision"`
	DocumentSHA256 string `json:"documentSha256"`
	Chunks         int    `json:"chunks"`
	Status         string `json:"status"`
}
type RetrievalDelete struct {
	Corpus   string `json:"corpus"`
	SourceID string `json:"sourceId"`
	Revision string `json:"revision"`
}
type RetrievalDeleteResult struct {
	RetrievalDelete
	Deleted bool `json:"deleted"`
}

var embeddingModelPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`)

func retrievalValid(data []byte) bool {
	value, ok := object(data)
	if !ok || !matches(value["corpus"], sourceIDPattern) || !boolValue(value["truncated"]) {
		return false
	}
	index, ok := object(value["index"])
	if !ok {
		return false
	}
	for _, key := range []string{"providerId", "vendor", "accountId", "version"} {
		if !matches(index[key], sourceIDPattern) {
			return false
		}
	}
	mode, _ := stringValue(index["authMode"])
	metric, _ := stringValue(index["metric"])
	var dimensions int
	if (mode != "api-key" && mode != "none") || metric != "cosine" || !matches(index["model"], embeddingModelPattern) ||
		json.Unmarshal(index["dimensions"], &dimensions) != nil || dimensions < 1 || dimensions > 4096 {
		return false
	}
	var hits []json.RawMessage
	if json.Unmarshal(value["hits"], &hits) != nil || hits == nil || len(hits) > 16 {
		return false
	}
	ids := map[string]bool{}
	for _, raw := range hits {
		hit, ok := object(raw)
		if !ok || !matches(hit["chunkId"], sourceIDPattern) || !matches(hit["documentSha256"], digestPattern) || !boundedText(hit["text"], 16384, false) {
			return false
		}
		id, _ := stringValue(hit["chunkId"])
		if ids[id] {
			return false
		}
		ids[id] = true
		var score float64
		if string(hit["score"]) == "null" || json.Unmarshal(hit["score"], &score) != nil || math.IsNaN(score) || math.IsInf(score, 0) || score < -1 || score > 1 {
			return false
		}
		source, ok := object(hit["source"])
		if !ok {
			return false
		}
		source["bytes"] = json.RawMessage(`1`)
		source["mediaType"] = json.RawMessage(`"text/plain"`)
		source["origin"] = json.RawMessage(`"inline"`)
		source["sha256"] = json.RawMessage(`"0000000000000000000000000000000000000000000000000000000000000000"`)
		encoded, _ := json.Marshal(source)
		if !sourceValid(encoded) {
			return false
		}
	}
	return true
}
func (result *RetrievalResult) UnmarshalJSON(data []byte) error {
	type plain RetrievalResult
	var value plain
	if !retrievalValid(data) || json.Unmarshal(data, &value) != nil {
		return invalidRetrieval()
	}
	*result = RetrievalResult(value)
	return nil
}
func invalidRetrieval() error {
	return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned invalid retrieval evidence or a mismatched receipt."}
}
func retrievalSelection(result *RetrievalResult, request *RetrievalRequest) bool {
	if result == nil || request == nil {
		return result == nil && request == nil
	}
	limit, budget := request.Limit, request.MaxContextBytes
	if limit == 0 {
		limit = 8
	}
	if budget == 0 {
		budget = 65536
	}
	if result.Corpus != request.Corpus || len(result.Hits) > limit {
		return false
	}
	total := 0
	for _, hit := range result.Hits {
		total += len(hit.Text)
		if request.MinScore != nil && hit.Score < *request.MinScore {
			return false
		}
		if len(request.SourceIDs) > 0 {
			found := false
			for _, id := range request.SourceIDs {
				if id == hit.Source.ID {
					found = true
				}
			}
			if !found {
				return false
			}
		}
	}
	return total <= budget
}
func retrievalLinks(result *Result) bool {
	hits := []RetrievalHit{}
	if result.Retrieval != nil {
		hits = result.Retrieval.Hits
	}
	sources := []ContextManifest{}
	for _, source := range result.Sources {
		if source.Origin == "retrieval" {
			sources = append(sources, source)
		}
	}
	if len(sources) != len(hits) {
		return false
	}
	for _, hit := range hits {
		found := false
		for _, source := range sources {
			if source.ID == hit.ChunkID && source.Revision == hit.Source.Revision && source.Location != nil && source.Location.DocumentID == hit.Source.ID && source.Bytes == len(hit.Text) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func (c *Client) SearchContext(ctx context.Context, request RetrievalSearch) (*RetrievalResult, error) {
	response, err := c.request(ctx, "v1/retrieval/search", request, false)
	if err != nil {
		return nil, err
	}
	var result RetrievalResult
	if err = decode(response, &result); err != nil {
		return nil, err
	}
	if !retrievalSelection(&result, &request) {
		return nil, invalidRetrieval()
	}
	return &result, nil
}
func (c *Client) IndexContext(ctx context.Context, request RetrievalIndexRequest) (*RetrievalIndexResult, error) {
	response, err := c.request(ctx, "v1/retrieval/index", request, false)
	if err != nil {
		return nil, err
	}
	var raw wireObject
	if err = decode(response, &raw); err != nil {
		return nil, err
	}
	var result RetrievalIndexResult
	data, _ := json.Marshal(raw)
	if json.Unmarshal(data, &result) != nil || result.Corpus != request.Corpus || result.SourceID != request.Source.ID || result.Revision != request.Source.Revision ||
		!matches(raw["documentSha256"], digestPattern) || !numberValue(raw["chunks"], true, true) || result.Chunks > 256 || (result.Status != "indexed" && result.Status != "unchanged") {
		return nil, invalidRetrieval()
	}
	return &result, nil
}
func (c *Client) DeleteContext(ctx context.Context, request RetrievalDelete) (*RetrievalDeleteResult, error) {
	response, err := c.request(ctx, "v1/retrieval/delete", request, false)
	if err != nil {
		return nil, err
	}
	var raw wireObject
	if err = decode(response, &raw); err != nil {
		return nil, err
	}
	var result RetrievalDeleteResult
	data, _ := json.Marshal(raw)
	if json.Unmarshal(data, &result) != nil || result.RetrievalDelete != request || !boolValue(raw["deleted"]) {
		return nil, invalidRetrieval()
	}
	return &result, nil
}
