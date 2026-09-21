//! Explicit detached jobs. Reading an event page never executes application tools.
use crate::{Event, RunRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct JobSubmit {
    pub key: String,
    pub request: RunRequest,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobIdentity {
    pub id: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct JobEventsRequest {
    pub id: String,
    pub after: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl JobState {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}
#[derive(Debug, Deserialize)]
#[serde(try_from = "Value")]
pub struct JobInfo {
    pub id: String,
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub state: JobState,
    pub cursor: u64,
    pub cancel_requested: bool,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
}
impl JobInfo {
    pub fn identity(&self) -> JobIdentity {
        JobIdentity {
            id: self.id.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEventPage {
    pub job: JobInfo,
    pub events: Vec<Event>,
    pub next_cursor: u64,
    pub has_more: bool,
}
fn id_valid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn date_valid(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes()[19] == b'.'
        && value.ends_with('Z')
        && crate::validation::timestamp_valid(value)
}
impl TryFrom<Value> for JobInfo {
    type Error = &'static str;
    fn try_from(value: Value) -> std::result::Result<Self, Self::Error> {
        let invalid = "Invalid durable job metadata";
        let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or("");
        let state: JobState = serde_json::from_value(value.get("state").cloned().ok_or(invalid)?)
            .map_err(|_| invalid)?;
        let cursor = value.get("cursor").and_then(Value::as_u64).ok_or(invalid)?;
        let cancel_requested = value
            .get("cancelRequested")
            .and_then(Value::as_bool)
            .ok_or(invalid)?;
        if !id_valid(text("id"))
            || !id_valid(text("runId"))
            || text("provider").is_empty()
            || text("model").is_empty()
            || cursor > 9_007_199_254_740_991
            || !date_valid(text("createdAt"))
            || !date_valid(text("updatedAt"))
            || text("updatedAt") < text("createdAt")
            || state.is_terminal() != value.get("expiresAt").is_some()
            || (state.is_terminal()
                && (!date_valid(text("expiresAt"))
                    || text("expiresAt") <= text("updatedAt")
                    || cursor < 2))
            || (state == JobState::Queued && cursor != 0)
        {
            return Err(invalid);
        }
        Ok(Self {
            id: text("id").into(),
            run_id: text("runId").into(),
            provider: text("provider").into(),
            model: text("model").into(),
            state,
            cursor,
            cancel_requested,
            created_at: text("createdAt").into(),
            updated_at: text("updatedAt").into(),
            expires_at: value.get("expiresAt").map(|_| text("expiresAt").into()),
        })
    }
}
#[cfg(any(feature = "blocking", feature = "async"))]
fn invalid() -> crate::Error {
    crate::protocol_error(
        "INVALID_RESPONSE",
        "Invalid or mismatched durable job response.",
    )
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn info(
    value: Value,
    submit: Option<&JobSubmit>,
    identity: Option<&JobIdentity>,
) -> crate::Result<JobInfo> {
    let result: JobInfo = serde_json::from_value(value).map_err(|_| invalid())?;
    if submit
        .is_some_and(|s| result.provider != s.request.provider || result.model != s.request.model)
        || identity.is_some_and(|i| result.id != i.id)
    {
        return Err(invalid());
    }
    Ok(result)
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn page(value: Value, input: &JobEventsRequest) -> crate::Result<JobEventPage> {
    let page: JobEventPage = serde_json::from_value(value).map_err(|_| invalid())?;
    if page.job.id != input.id
        || page.events.len() > input.limit.unwrap_or(100).min(100) as usize
        || input.after > 9_007_199_254_740_991
    {
        return Err(invalid());
    }
    let mut cursor = input.after;
    for event in &page.events {
        let mut request = RunRequest::new(&page.job.provider, &page.job.model, "");
        if let Some(retrieval) = event.result.as_ref().and_then(|r| r.retrieval.as_ref()) {
            request.retrieval = Some(crate::RetrievalRequest {
                corpus: retrieval.corpus.clone(),
                limit: Some(16),
                max_context_bytes: Some(2_000_000),
                ..Default::default()
            });
        }
        cursor += 1;
        if !matches!(
            event.kind.as_str(),
            "run.started"
                | "step.started"
                | "text.delta"
                | "run.progress"
                | "tool.called"
                | "tool.completed"
                | "usage.reported"
                | "run.completed"
                | "run.failed"
                | "run.cancelled"
        ) || !crate::validation::event_valid(event, &request, cursor == 1)
            || event.sequence != cursor
            || event.run_id != page.job.run_id
            || cursor > page.job.cursor
        {
            return Err(invalid());
        }
        let ended = event.is_terminal();
        if (ended && (cursor != page.job.cursor || !page.job.state.is_terminal()))
            || (cursor == page.job.cursor && page.job.state.is_terminal() && !ended)
            || (event.kind == "run.completed" && page.job.state != JobState::Completed)
            || (event.kind == "run.cancelled" && page.job.state != JobState::Cancelled)
            || (event.kind == "run.failed"
                && (!matches!(page.job.state, JobState::Failed | JobState::Interrupted)
                    || (page.job.state == JobState::Interrupted
                        && event.error.as_ref().and_then(|e| e.outcome)
                            != Some(crate::ErrorOutcome::Uncertain))))
        {
            return Err(invalid());
        }
    }
    if page.next_cursor != cursor
        || cursor > page.job.cursor
        || page.has_more != (cursor < page.job.cursor)
        || (page.has_more && page.events.is_empty())
    {
        return Err(invalid());
    }
    Ok(page)
}
