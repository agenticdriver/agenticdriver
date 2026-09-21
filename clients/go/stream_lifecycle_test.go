package agenticdriver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// HTTP readers may return the last bytes and io.EOF together. A scanner must
// still parse every buffered frame after consuming the LF of a prior CRLF.
type eofChunkReader struct {
	body   []byte
	width  int
	closed bool
}

func (r *eofChunkReader) Read(p []byte) (int, error) {
	n := len(r.body)
	if n > r.width {
		n = r.width
	}
	if n > len(p) {
		n = len(p)
	}
	copy(p, r.body[:n])
	r.body = r.body[n:]
	if len(r.body) == 0 {
		return n, io.EOF
	}
	return n, nil
}
func (r *eofChunkReader) Close() error { r.closed = true; return nil }
func lifecycleStream(ending string) string {
	events := []any{
		map[string]any{"type": "run.started", "runId": "fixture-run", "sequence": 1, "timestamp": "2026-09-21T00:00:00Z", "provider": "mock", "model": "demo"},
		map[string]any{"type": "text.delta", "runId": "fixture-run", "sequence": 2, "timestamp": "2026-09-21T00:00:00Z", "text": "Hello 🌍"},
		map[string]any{"type": "run.completed", "runId": "fixture-run", "sequence": 3, "timestamp": "2026-09-21T00:00:00Z", "result": map[string]any{"runId": "fixture-run", "provider": "mock", "model": "demo", "text": "Hello 🌍", "usage": map[string]any{}, "steps": 1, "finishReason": "stop"}},
	}
	body := "\ufeff"
	for _, event := range events {
		value, _ := json.MarshalIndent(event, "", "  ")
		body += ": comment" + ending + "data: " + strings.ReplaceAll(string(value), "\n", ending+"data: ") + ending + ending
	}
	return body
}
func TestFinalReadKeepsAllBufferedSSEFrames(t *testing.T) {
	for _, ending := range []string{"\n", "\r", "\r\n"} {
		for width := 1; width <= 64; width++ {
			t.Run(fmt.Sprintf("ending-%q-width-%d", ending, width), func(t *testing.T) {
				reader := &eofChunkReader{body: []byte(lifecycleStream(ending)), width: width}
				client, err := NewWithTransport("https://fixture.example", "test-token", fixtureTransport(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: reader}, nil
				}))
				if err != nil {
					t.Fatal(err)
				}
				var types []string
				err = client.Stream(context.Background(), Request{Provider: "mock", Model: "demo", Input: "Hello"}, func(e Event) error { types = append(types, e.Type); return nil })
				if err != nil || len(types) != 3 || types[2] != "run.completed" {
					t.Fatalf("events %v: %v", types, err)
				}
				if !reader.closed {
					t.Fatal("response body not closed")
				}
			})
		}
	}
}

type failingBody struct {
	closed bool
	err    error
}

func (r *failingBody) Read([]byte) (int, error) { return 0, r.err }
func (r *failingBody) Close() error             { r.closed = true; return nil }
func TestStreamCleanupOnCallbackAndTransportFailure(t *testing.T) {
	sentinel := fmt.Errorf("caller stopped processing")
	reader := &eofChunkReader{body: []byte(lifecycleStream("\n")), width: 4096}
	var requestContext context.Context
	client, _ := NewWithTransport("https://fixture.example", "fixture", fixtureTransport(func(r *http.Request) (*http.Response, error) {
		requestContext = r.Context()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: reader}, nil
	}))
	request := Request{Provider: "mock", Model: "demo", Input: "Hello"}
	err := client.Stream(context.Background(), request, func(Event) error { return sentinel })
	if err != sentinel || !reader.closed || requestContext.Err() != context.Canceled {
		t.Fatalf("callback cleanup: %v, closed %v, context %v", err, reader.closed, requestContext.Err())
	}
	broken := &failingBody{err: io.ErrUnexpectedEOF}
	client, _ = NewWithTransport("https://fixture.example", "fixture", fixtureTransport(func(r *http.Request) (*http.Response, error) {
		requestContext = r.Context()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: broken}, nil
	}))
	err = client.Stream(context.Background(), request, func(Event) error { return nil })
	if err != io.ErrUnexpectedEOF || !broken.closed || requestContext.Err() != context.Canceled {
		t.Fatalf("read-error cleanup: %v", err)
	}
	called := false
	client, _ = NewWithTransport("https://fixture.example", "fixture", fixtureTransport(func(*http.Request) (*http.Response, error) { called = true; return nil, io.ErrUnexpectedEOF }))
	err = client.Stream(context.Background(), request, nil)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != "INVALID_CALLBACK" || called {
		t.Fatalf("nil callback: %v, contacted host %v", err, called)
	}
}

type cancelledBody struct {
	ctx     context.Context
	started chan struct{}
	closed  chan struct{}
}

func (r *cancelledBody) Read([]byte) (int, error) {
	select {
	case <-r.started:
	default:
		close(r.started)
	}
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}
func (r *cancelledBody) Close() error { close(r.closed); return nil }
func TestCancellationReleasesPendingReaderAndBody(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := &cancelledBody{started: make(chan struct{}), closed: make(chan struct{})}
	client, _ := NewWithTransport("https://fixture.example", "fixture", fixtureTransport(func(r *http.Request) (*http.Response, error) {
		body.ctx = r.Context()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: body}, nil
	}))
	finished := make(chan error, 1)
	go func() {
		finished <- client.Stream(parent, Request{Provider: "mock", Model: "demo", Input: "Hello"}, func(Event) error { return nil })
	}()
	select {
	case <-body.started:
	case <-time.After(2 * time.Second):
		t.Fatal("reader never started")
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream goroutine did not finish")
	}
	select {
	case <-body.closed:
	default:
		t.Fatal("cancelled response body not closed")
	}
}

func TestTypedEventPayloads(t *testing.T) {
	cases := []string{
		`{"type":"run.started","provider":"mock","model":"demo"}`,
		`{"type":"step.started","step":2}`,
		`{"type":"run.progress","phase":"context"}`,
		`{"type":"tool.called","call":{"id":"call-1","name":"read_document","arguments":{"id":"paper"}}}`,
		`{"type":"tool.completed","callId":"call-1","output":{"found":true}}`,
		`{"type":"usage.reported","step":2,"usage":{"inputTokens":7}}`,
	}
	events := make([]Event, len(cases))
	for i, raw := range cases {
		if err := json.Unmarshal([]byte(raw), &events[i]); err != nil {
			t.Fatal(err)
		}
	}
	if events[0].Provider != "mock" || events[0].Model != "demo" || events[1].Step != 2 || events[2].Phase != "context" || events[3].Call.Name != "read_document" || string(events[3].Call.Arguments["id"]) != `"paper"` || events[4].CallID != "call-1" || string(events[4].Output) != `{"found":true}` || *events[5].Usage.InputTokens != 7 {
		t.Fatal("lost typed event data")
	}
}
