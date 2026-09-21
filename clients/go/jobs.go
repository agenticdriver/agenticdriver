package agenticdriver

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

type JobSubmit struct {
	Key     string  `json:"key"`
	Request Request `json:"request"`
}
type JobIdentity struct {
	ID string `json:"id"`
}
type JobEventsRequest struct {
	ID    string `json:"id"`
	After int64  `json:"after"`
	Limit int    `json:"limit,omitempty"`
}
type JobInfo struct {
	ID              string  `json:"id"`
	RunID           string  `json:"runId"`
	Provider        string  `json:"provider"`
	Model           string  `json:"model"`
	State           string  `json:"state"`
	Cursor          int64   `json:"cursor"`
	CancelRequested bool    `json:"cancelRequested"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
	ExpiresAt       *string `json:"expiresAt,omitempty"`
}
type JobEventPage struct {
	Job        JobInfo `json:"job"`
	Events     []Event `json:"events"`
	NextCursor int64   `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

var jobID = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

func invalidJob() error {
	return &Error{Code: "INVALID_RESPONSE", Message: "Invalid job metadata or event page."}
}
func jobDate(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && sessionDate.MatchString(value)
}
func jobTerminal(state string) bool { return state != "queued" && state != "running" }
func (info *JobInfo) UnmarshalJSON(data []byte) error {
	type plain JobInfo
	fields, ok := object(data)
	var value plain
	if !ok || json.Unmarshal(exactSessionFields(fields, "id", "runId", "provider", "model", "state", "cursor", "cancelRequested", "createdAt", "updatedAt", "expiresAt"), &value) != nil ||
		!jobID.MatchString(value.ID) || !jobID.MatchString(value.RunID) || !stringField(fields, "provider", false) || !stringField(fields, "model", false) ||
		!numberValue(fields["cursor"], false, true) || !boolValue(fields["cancelRequested"]) || !jobDate(value.CreatedAt) || !jobDate(value.UpdatedAt) || value.UpdatedAt < value.CreatedAt {
		return invalidJob()
	}
	switch value.State {
	case "queued", "running", "completed", "failed", "cancelled", "interrupted":
	default:
		return invalidJob()
	}
	_, expiry := fields["expiresAt"]
	terminal := jobTerminal(value.State)
	if terminal != expiry || (expiry && (value.ExpiresAt == nil || !jobDate(*value.ExpiresAt) || *value.ExpiresAt <= value.UpdatedAt)) ||
		(value.State == "queued" && value.Cursor != 0) || (terminal && value.Cursor < 2) {
		return invalidJob()
	}
	*info = JobInfo(value)
	return nil
}
func (c *Client) SubmitJob(ctx context.Context, request JobSubmit) (JobInfo, error) {
	result, err := c.jobRequest(ctx, "submit", request)
	if err == nil && (result.Provider != request.Request.Provider || result.Model != request.Request.Model) {
		err = invalidJob()
	}
	return result, err
}
func (c *Client) ReadJob(ctx context.Context, request JobIdentity) (JobInfo, error) {
	result, err := c.jobRequest(ctx, "read", request)
	if err == nil && result.ID != request.ID {
		err = invalidJob()
	}
	return result, err
}
func (c *Client) CancelJob(ctx context.Context, request JobIdentity) (JobInfo, error) {
	result, err := c.jobRequest(ctx, "cancel", request)
	if err == nil && result.ID != request.ID {
		err = invalidJob()
	}
	return result, err
}
func (c *Client) jobRequest(ctx context.Context, operation string, input any) (JobInfo, error) {
	var result JobInfo
	res, err := c.request(ctx, "v1/jobs/"+operation, input, false)
	if err != nil {
		return result, err
	}
	err = decode(res, &result)
	return result, err
}

// JobEvents returns observations only; it does not execute tools or retry jobs.
func (c *Client) JobEvents(ctx context.Context, input JobEventsRequest) (JobEventPage, error) {
	var raw json.RawMessage
	var page JobEventPage
	res, err := c.request(ctx, "v1/jobs/events", input, false)
	if err != nil {
		return page, err
	}
	if err = decode(res, &raw); err != nil {
		return page, err
	}
	fields, ok := object(raw)
	var events []json.RawMessage
	if !ok || json.Unmarshal(fields["job"], &page.Job) != nil || json.Unmarshal(fields["events"], &events) != nil || events == nil ||
		!numberValue(fields["nextCursor"], false, true) || json.Unmarshal(fields["nextCursor"], &page.NextCursor) != nil ||
		!boolValue(fields["hasMore"]) || json.Unmarshal(fields["hasMore"], &page.HasMore) != nil || page.Job.ID != input.ID {
		return page, invalidJob()
	}
	limit := input.Limit
	if limit == 0 {
		limit = 100
	}
	if len(events) > limit || len(events) > 100 {
		return page, invalidJob()
	}
	cursor := input.After
	page.Events = []Event{}
	for _, rawEvent := range events {
		fields, ok := object(rawEvent)
		var event Event
		if !ok || json.Unmarshal(exactSessionFields(fields, "type", "runId", "sequence", "timestamp", "optional", "provider", "model", "step", "phase", "call", "callId", "output", "usage", "text", "result", "error"), &event) != nil {
			return page, invalidJob()
		}
		request := Request{Provider: page.Job.Provider, Model: page.Job.Model}
		if event.Result != nil && event.Result.Retrieval != nil {
			request.Retrieval = &RetrievalRequest{Corpus: event.Result.Retrieval.Corpus, Limit: 16, MaxContextBytes: 2000000}
		}
		cursor++
		if !knownEvent(event.Type) || strings.HasPrefix(event.Type, "approval.") || event.Type == "tool.execution.requested" ||
			!eventValid(rawEvent, event, request, cursor == 1) || int64(event.Sequence) != cursor || event.RunID != page.Job.RunID || cursor > page.Job.Cursor {
			return page, invalidJob()
		}
		ended := event.Type == "run.completed" || event.Type == "run.failed" || event.Type == "run.cancelled"
		terminal := jobTerminal(page.Job.State)
		if (ended && (cursor != page.Job.Cursor || !terminal)) || (cursor == page.Job.Cursor && terminal && !ended) ||
			(event.Type == "run.completed" && page.Job.State != "completed") || (event.Type == "run.cancelled" && page.Job.State != "cancelled") ||
			(event.Type == "run.failed" && (page.Job.State != "failed" && page.Job.State != "interrupted" || page.Job.State == "interrupted" && event.Error.Outcome != "uncertain")) {
			return page, invalidJob()
		}
		event.Raw = rawEvent
		page.Events = append(page.Events, event)
	}
	if page.NextCursor != cursor || cursor > page.Job.Cursor || page.HasMore != (cursor < page.Job.Cursor) || (page.HasMore && len(events) == 0) {
		return page, invalidJob()
	}
	return page, nil
}
