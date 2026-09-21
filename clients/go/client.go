// Package agenticdriver connects applications to an authenticated AgenticDriver host.
package agenticdriver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const ProtocolVersion = "1.0"

type ProtocolInfo struct {
	Protocol          string   `json:"protocol"`
	Version           string   `json:"version"`
	SupportedVersions []string `json:"supportedVersions"`
	Features          []string `json:"features"`
}

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Outcome   string `json:"outcome,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type Request struct {
	Retrieval            *RetrievalRequest `json:"retrieval,omitempty"`
	Attachments          []ContextInput    `json:"attachments,omitempty"`
	OutputArtifact       *ArtifactRequest  `json:"outputArtifact,omitempty"`
	Provider             string            `json:"provider"`
	Model                string            `json:"model"`
	Input                string            `json:"input"`
	IdempotencyKey       string            `json:"idempotencyKey,omitempty"`
	Retry                *RetryPolicy      `json:"retry,omitempty"`
	Instructions         string            `json:"instructions,omitempty"`
	History              []Message         `json:"history,omitempty"`
	Tools                []string          `json:"tools,omitempty"`
	RequiredCapabilities []string          `json:"requiredCapabilities,omitempty"`
	MaxSteps             int               `json:"maxSteps,omitempty"`
	MaxOutputTokens      int               `json:"maxOutputTokens,omitempty"`
	IdleTimeoutMs        int               `json:"idleTimeoutMs,omitempty"`
	OutputSchema         map[string]any    `json:"outputSchema,omitempty"`
	Metadata             map[string]string `json:"metadata,omitempty"`
}
type RetryPolicy struct {
	MaxAttempts int  `json:"maxAttempts"`
	BaseDelayMs *int `json:"baseDelayMs,omitempty"`
	MaxDelayMs  *int `json:"maxDelayMs,omitempty"`
}
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Usage struct {
	InputTokens          *int64   `json:"inputTokens,omitempty"`
	OutputTokens         *int64   `json:"outputTokens,omitempty"`
	CachedInputTokens    *int64   `json:"cachedInputTokens,omitempty"`
	ReasoningTokens      *int64   `json:"reasoningTokens,omitempty"`
	CostUSD              *float64 `json:"costUsd,omitempty"`
	APIEquivalentCostUSD *float64 `json:"apiEquivalentCostUsd,omitempty"`
}
type Result struct {
	Retrieval    *RetrievalResult  `json:"retrieval,omitempty"`
	Sources      []ContextManifest `json:"sources,omitempty"`
	Artifacts    []DraftArtifact   `json:"artifacts,omitempty"`
	RunID        string            `json:"runId"`
	Provider     string            `json:"provider"`
	Model        string            `json:"model"`
	Text         string            `json:"text"`
	Output       json.RawMessage   `json:"output,omitempty"`
	Usage        Usage             `json:"usage"`
	Steps        int               `json:"steps"`
	FinishReason string            `json:"finishReason"`
}
type Provider struct {
	InputMediaTypes map[string][]string `json:"inputMediaTypes,omitempty"`
	ID              string              `json:"id"`
	Name            string              `json:"name"`
	Vendor          string              `json:"vendor"`
	AuthMode        string              `json:"authMode"`
	Models          []string            `json:"models,omitempty"`
	UsageStatID     string              `json:"usageStatId,omitempty"`
	Health          *ProviderHealth     `json:"health,omitempty"`
	ModelCatalog    *ModelCatalog       `json:"modelCatalog,omitempty"`
	Capabilities    struct {
		Tools         bool `json:"tools"`
		TextStreaming bool `json:"textStreaming"`
	} `json:"capabilities"`
}
type ProviderHealth struct {
	Status    string `json:"status"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	CheckedAt string `json:"checkedAt"`
}
type ModelCatalog struct {
	Source   string   `json:"source"`
	Models   []string `json:"models"`
	Complete bool     `json:"complete"`
}
type Event struct {
	Provider  string          `json:"provider,omitempty"`
	Model     string          `json:"model,omitempty"`
	Step      int             `json:"step,omitempty"`
	Phase     string          `json:"phase,omitempty"`
	Call      *ToolCall       `json:"call,omitempty"`
	CallID    string          `json:"callId,omitempty"`
	Output    json.RawMessage `json:"output,omitempty"`
	Usage     *Usage          `json:"usage,omitempty"`
	Type      string          `json:"type"`
	RunID     string          `json:"runId"`
	Sequence  int             `json:"sequence"`
	Timestamp string          `json:"timestamp"`
	Optional  bool            `json:"optional,omitempty"`
	Text      string          `json:"text,omitempty"`
	Result    *Result         `json:"result,omitempty"`
	Error     *Error          `json:"error,omitempty"`
	Raw       json.RawMessage `json:"-"`
}
type ToolCall struct {
	ID        string                     `json:"id"`
	Name      string                     `json:"name"`
	Arguments map[string]json.RawMessage `json:"arguments"`
}
type Client struct {
	base  string
	token string
	http  *http.Client
}

func New(baseURL, token string) (*Client, error) {
	return NewWithTransport(baseURL, token, http.DefaultTransport)
}

// NewWithTransport supports a custom CA or mTLS transport; TLS verification remains the caller's responsibility.
func NewWithTransport(baseURL, token string, transport http.RoundTripper) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" || !(u.Scheme == "https" || (u.Scheme == "http" && local)) {
		return nil, &Error{Code: "INSECURE_TRANSPORT", Message: "Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment."}
	}
	if token == "" {
		return nil, &Error{Code: "AUTH_REQUIRED", Message: "A driver bearer token is required."}
	}
	return &Client{base: strings.TrimRight(u.String(), "/") + "/", token: token, http: &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) request(ctx context.Context, path string, body any, stream bool) (*http.Response, error) {
	var encoded []byte
	var err error
	method := http.MethodGet
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("AgenticDriver-Version", ProtocolVersion)
	req.Header.Set("AgenticDriver-Accept-Optional-Events", "true")
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		defer res.Body.Close()
		var payload struct {
			Error *Error `json:"error"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64000)).Decode(&payload)
		if decodeErr == nil && payload.Error != nil {
			return nil, payload.Error
		}
		return nil, &Error{Code: "HTTP_ERROR", Message: fmt.Sprintf("Driver returned HTTP %d.", res.StatusCode), Retryable: res.StatusCode == 429 || res.StatusCode >= 500}
	}
	if values, present := res.Header[http.CanonicalHeaderKey("AgenticDriver-Version")]; present && (len(values) != 1 || values[0] != ProtocolVersion) {
		res.Body.Close()
		return nil, &Error{Code: "UNSUPPORTED_PROTOCOL_VERSION", Message: "The host selected an unsupported wire protocol version."}
	}
	return res, nil
}
func decode(res *http.Response, target any) error {
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 2000001))
	if err != nil {
		return err
	}
	if len(data) > 2000000 {
		return &Error{Code: "RESPONSE_TOO_LARGE", Message: "Response exceeded 2 MB."}
	}
	if !utf8.Valid(data) {
		return &Error{Code: "INVALID_RESPONSE", Message: "The response is not valid UTF-8."}
	}
	if err := json.Unmarshal(data, target); err != nil {
		return &Error{Code: "INVALID_RESPONSE", Message: "The driver returned invalid JSON or an invalid response shape."}
	}
	return nil
}
func (c *Client) Providers(ctx context.Context) ([]Provider, error) {
	return c.providers(ctx, false)
}
func (c *Client) RefreshProviders(ctx context.Context) ([]Provider, error) {
	return c.providers(ctx, true)
}
func (c *Client) providers(ctx context.Context, refresh bool) ([]Provider, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	path := "v1/providers"
	if refresh {
		path += "?refresh=true"
	}
	res, err := c.request(ctx, path, nil, false)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Providers []Provider `json:"providers"`
	}
	err = decode(res, &payload)
	if err == nil && payload.Providers == nil {
		err = &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid provider catalog."}
	}
	return payload.Providers, err
}
func (c *Client) Protocol(ctx context.Context) (ProtocolInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var info ProtocolInfo
	res, err := c.request(ctx, "v1/protocol", nil, false)
	if err != nil {
		return info, err
	}
	if err = decode(res, &info); err != nil {
		return info, err
	}
	supported := false
	for _, version := range info.SupportedVersions {
		supported = supported || version == ProtocolVersion
	}
	if info.Protocol != "agenticdriver" || info.Version != ProtocolVersion || !supported || info.Features == nil {
		return info, &Error{Code: "INVALID_RESPONSE", Message: "The driver returned an invalid protocol descriptor."}
	}
	return info, nil
}
func (c *Client) Run(ctx context.Context, request Request) (Result, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var result Result
	res, err := c.request(ctx, "v1/runs", request, false)
	if err != nil {
		return result, err
	}
	err = decode(res, &result)
	if err == nil && (result.Provider != request.Provider || result.Model != request.Model || !retrievalSelection(result.Retrieval, request.Retrieval)) {
		err = &Error{Code: "INVALID_RESPONSE", Message: "The result does not match the requested provider and model."}
	}
	return result, err
}

// Stream closes the HTTP response when context is cancelled or the callback returns an error.
func (c *Client) Stream(ctx context.Context, request Request, visit func(Event) error) error {
	if visit == nil {
		return &Error{Code: "INVALID_CALLBACK", Message: "Stream requires an event callback."}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	res, err := c.request(ctx, "v1/runs", request, true)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		return &Error{Code: "INVALID_RESPONSE", Message: "Expected SSE."}
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), maxWireBytes+2)
	scanner.Split(splitSSELines())
	fields := []string{}
	sequence, size := 0, 0
	runID := ""
	firstLine := true
	for scanner.Scan() {
		line := stripBOM(scanner.Text(), &firstLine)
		if !utf8.ValidString(line) {
			return &Error{Code: "INVALID_STREAM", Message: "The event stream is not valid UTF-8."}
		}
		size += len(line)
		if size > 2000000 {
			return &Error{Code: "RESPONSE_TOO_LARGE", Message: "Event exceeded 2 MB."}
		}
		if strings.HasPrefix(line, "data:") {
			fields = append(fields, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		if line != "" {
			continue
		}
		if len(fields) > 0 {
			data := []byte(strings.Join(fields, "\n"))
			var event Event
			if err := json.Unmarshal(data, &event); err != nil {
				return &Error{Code: "INVALID_STREAM", Message: "The event stream contained invalid JSON or an invalid payload."}
			}
			if !eventValid(data, event, request, sequence == 0) || event.Sequence != sequence+1 || (runID != "" && event.RunID != runID) {
				return &Error{Code: "INVALID_STREAM", Message: "Invalid or out-of-order event."}
			}
			sequence, runID = event.Sequence, event.RunID
			if !knownEvent(event.Type) {
				if !event.Optional {
					return &Error{Code: "UNSUPPORTED_EVENT", Message: "The host sent an unknown required event type."}
				}
				fields, size = nil, 0
				continue
			}
			event.Raw = data
			if err := visit(event); err != nil {
				return err
			}
			if event.Type == "run.completed" {
				return nil
			}
			if event.Type == "run.failed" || event.Type == "run.cancelled" {
				if event.Error != nil {
					return event.Error
				}
				return errors.New("run failed without error details")
			}
		}
		fields = nil
		size = 0
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return &Error{Code: "INCOMPLETE_STREAM", Message: "Connection closed before a terminal event."}
}

func knownEvent(kind string) bool {
	switch kind {
	case "run.started", "step.started", "text.delta", "run.progress", "tool.called", "tool.completed", "usage.reported", "run.completed", "run.failed", "run.cancelled":
		return true
	default:
		return false
	}
}
