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
)

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type Request struct {
	Provider        string            `json:"provider"`
	Model           string            `json:"model"`
	Input           string            `json:"input"`
	Instructions    string            `json:"instructions,omitempty"`
	History         []Message         `json:"history,omitempty"`
	Tools           []string          `json:"tools,omitempty"`
	MaxSteps        int               `json:"maxSteps,omitempty"`
	MaxOutputTokens int               `json:"maxOutputTokens,omitempty"`
	IdleTimeoutMs   int               `json:"idleTimeoutMs,omitempty"`
	OutputSchema    map[string]any    `json:"outputSchema,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Usage struct {
	InputTokens       *int64   `json:"inputTokens,omitempty"`
	OutputTokens      *int64   `json:"outputTokens,omitempty"`
	CachedInputTokens *int64   `json:"cachedInputTokens,omitempty"`
	ReasoningTokens   *int64   `json:"reasoningTokens,omitempty"`
	CostUSD           *float64 `json:"costUsd,omitempty"`
}
type Result struct {
	RunID        string          `json:"runId"`
	Provider     string          `json:"provider"`
	Model        string          `json:"model"`
	Text         string          `json:"text"`
	Output       json.RawMessage `json:"output,omitempty"`
	Usage        Usage           `json:"usage"`
	Steps        int             `json:"steps"`
	FinishReason string          `json:"finishReason"`
}
type Provider struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Vendor       string   `json:"vendor"`
	AuthMode     string   `json:"authMode"`
	Models       []string `json:"models,omitempty"`
	UsageStatID  string   `json:"usageStatId,omitempty"`
	Capabilities struct {
		Tools         bool `json:"tools"`
		TextStreaming bool `json:"textStreaming"`
	} `json:"capabilities"`
}
type Event struct {
	Type      string          `json:"type"`
	RunID     string          `json:"runId"`
	Sequence  int             `json:"sequence"`
	Timestamp string          `json:"timestamp"`
	Text      string          `json:"text,omitempty"`
	Result    *Result         `json:"result,omitempty"`
	Error     *Error          `json:"error,omitempty"`
	Raw       json.RawMessage `json:"-"`
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
		_ = json.NewDecoder(io.LimitReader(res.Body, 64000)).Decode(&payload)
		if payload.Error != nil {
			return nil, payload.Error
		}
		return nil, &Error{Code: "HTTP_ERROR", Message: fmt.Sprintf("Driver returned HTTP %d.", res.StatusCode)}
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
	return json.Unmarshal(data, target)
}
func (c *Client) Providers(ctx context.Context) ([]Provider, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := c.request(ctx, "v1/providers", nil, false)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Providers []Provider `json:"providers"`
	}
	err = decode(res, &payload)
	return payload.Providers, err
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
	return result, err
}

// Stream closes the HTTP response when context is cancelled or the callback returns an error.
func (c *Client) Stream(ctx context.Context, request Request, visit func(Event) error) error {
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
	scanner.Buffer(make([]byte, 4096), 2000000)
	fields := []string{}
	sequence, size := 0, 0
	runID := ""
	for scanner.Scan() {
		line := scanner.Text()
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
				return err
			}
			if event.Type == "" || event.RunID == "" || event.Sequence != sequence+1 || (runID != "" && event.RunID != runID) {
				return &Error{Code: "INVALID_STREAM", Message: "Invalid or out-of-order event."}
			}
			sequence, runID = event.Sequence, event.RunID
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
