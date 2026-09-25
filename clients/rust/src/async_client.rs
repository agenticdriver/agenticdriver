//! Native async transport with cancellation by dropping the in-flight future/stream.
use crate::{
    ingestion, protocol_error, retrieval, validation, DriverError, Error, Event, IngestRequest,
    IngestResult, ProtocolInfo, Provider, Result, RetrievalDelete, RetrievalDeleteResult,
    RetrievalIndexRequest, RetrievalIndexResult, RetrievalResult, RetrievalSearch, RunRequest,
    RunResult, PROTOCOL_VERSION,
};
use reqwest::{Client as HttpClient, Response};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::time::Duration;

#[derive(Clone)]
pub struct AsyncAgenticClient {
    base: reqwest::Url,
    token: String,
    http: HttpClient,
}
impl AsyncAgenticClient {
    pub fn new(url: &str, token: impl Into<String>) -> Result<Self> {
        Self::with_ca_pem(url, token, None)
    }
    /// Add a private CA without disabling certificate or hostname verification.
    pub fn with_ca_pem(url: &str, token: impl Into<String>, ca: Option<&[u8]>) -> Result<Self> {
        let token = token.into();
        let base = crate::transport::endpoint(url, &token)?;
        let mut builder = HttpClient::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10));
        if let Some(pem) = ca {
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(pem)?);
        }
        Ok(Self {
            base,
            token,
            http: builder.build()?,
        })
    }
    async fn request(&self, path: &str, body: Option<&Value>, stream: bool) -> Result<Response> {
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::Protocol("Invalid endpoint."))?;
        let mut request = if let Some(data) = body {
            self.http.post(url).json(data)
        } else {
            self.http.get(url)
        };
        request = request
            .bearer_auth(&self.token)
            .header("AgenticDriver-Version", PROTOCOL_VERSION)
            .header("AgenticDriver-Accept-Optional-Events", "true")
            .header(
                "Accept",
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            );
        if body.is_none() {
            request = request.timeout(Duration::from_secs(10));
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            #[derive(Deserialize)]
            struct Envelope {
                error: DriverError,
            }
            return match read_json::<Envelope>(response).await {
                Ok(payload) => Err(Error::Driver(payload.error)),
                Err(_) => Err(Error::Protocol("The driver returned an HTTP error.")),
            };
        }
        crate::transport::check_version(response.headers())?;
        Ok(response)
    }
    pub async fn ingest_context(&self, request: &IngestRequest) -> Result<IngestResult> {
        let value: Value = read_json(
            self.request(
                "v1/retrieval/ingest",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        let (id, revision) = request.document.identity();
        if !ingestion::valid(&value["ingestion"])
            || !retrieval::receipt(&value, &request.corpus, id, revision)
        {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Invalid ingestion provenance or a mismatched receipt.",
            ));
        }
        Ok(serde_json::from_value(value)?)
    }
    pub async fn search_context(&self, request: &RetrievalSearch) -> Result<RetrievalResult> {
        let value: Value = read_json(
            self.request(
                "v1/retrieval/search",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        if !retrieval::valid(&value) {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Invalid retrieval evidence.",
            ));
        }
        let result: RetrievalResult = serde_json::from_value(value)?;
        if !retrieval::selection(Some(&result), Some(request)) {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Evidence does not match the requested scope.",
            ));
        }
        Ok(result)
    }
    pub async fn index_context(
        &self,
        request: &RetrievalIndexRequest,
    ) -> Result<RetrievalIndexResult> {
        let value: Value = read_json(
            self.request(
                "v1/retrieval/index",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        if !retrieval::receipt(
            &value,
            &request.corpus,
            &request.source.id,
            &request.source.revision,
        ) {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Invalid indexing receipt.",
            ));
        }
        Ok(serde_json::from_value(value)?)
    }
    pub async fn delete_context(&self, request: &RetrievalDelete) -> Result<RetrievalDeleteResult> {
        let result: RetrievalDeleteResult = read_json(
            self.request(
                "v1/retrieval/delete",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        if &result.request != request {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Mismatched deletion receipt.",
            ));
        }
        Ok(result)
    }
    pub async fn protocol(&self) -> Result<ProtocolInfo> {
        let info: ProtocolInfo = read_json(self.request("v1/protocol", None, false).await?).await?;
        if info.protocol != "agenticdriver"
            || info.version != PROTOCOL_VERSION
            || !info
                .supported_versions
                .iter()
                .any(|v| v == PROTOCOL_VERSION)
        {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "The driver returned an invalid protocol descriptor.",
            ));
        }
        Ok(info)
    }
    pub async fn management(&self) -> Result<crate::ManagementSnapshot> {
        let value: Value = read_json(self.request("v1/management", None, false).await?).await?;
        crate::management::snapshot(value, None)
    }
    pub async fn configure_provider(
        &self,
        input: &crate::ConfigureProvider,
    ) -> Result<crate::ManagementSnapshot> {
        let value: Value = read_json(
            self.request(
                "v1/management/providers",
                Some(&serde_json::to_value(input)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::management::snapshot(value, Some(&input.provider.id))
    }
    pub async fn providers(&self) -> Result<Vec<Provider>> {
        self.provider_catalog(false).await
    }
    pub async fn refresh_providers(&self) -> Result<Vec<Provider>> {
        self.provider_catalog(true).await
    }
    async fn provider_catalog(&self, refresh: bool) -> Result<Vec<Provider>> {
        #[derive(Deserialize)]
        struct Catalog {
            providers: Vec<Provider>,
        }
        let path = if refresh {
            "v1/providers?refresh=true"
        } else {
            "v1/providers"
        };
        Ok(read_json::<Catalog>(self.request(path, None, false).await?)
            .await?
            .providers)
    }
    pub async fn submit_job(&self, request: &crate::JobSubmit) -> Result<crate::JobInfo> {
        let value: Value = read_json(
            self.request(
                "v1/jobs/submit",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::jobs::info(value, Some(request), None)
    }
    pub async fn read_job(&self, request: &crate::JobIdentity) -> Result<crate::JobInfo> {
        let value: Value = read_json(
            self.request("v1/jobs/read", Some(&serde_json::to_value(request)?), false)
                .await?,
        )
        .await?;
        crate::jobs::info(value, None, Some(request))
    }
    pub async fn cancel_job(&self, request: &crate::JobIdentity) -> Result<crate::JobInfo> {
        let value: Value = read_json(
            self.request(
                "v1/jobs/cancel",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::jobs::info(value, None, Some(request))
    }
    pub async fn job_events(
        &self,
        request: &crate::JobEventsRequest,
    ) -> Result<crate::JobEventPage> {
        let value: Value = read_json(
            self.request(
                "v1/jobs/events",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::jobs::page(value, request)
    }
    pub async fn create_session(
        &self,
        request: &crate::SessionCreate,
    ) -> Result<crate::SessionSnapshot> {
        let value: Value = read_json(
            self.request(
                "v1/sessions/create",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::sessions::snapshot(value, Some(request), None)
    }
    pub async fn read_session(
        &self,
        request: &crate::SessionIdentity,
    ) -> Result<crate::SessionSnapshot> {
        let value: Value = read_json(
            self.request(
                "v1/sessions/read",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::sessions::snapshot(value, None, Some(request))
    }
    pub async fn delete_session(
        &self,
        request: &crate::SessionIdentity,
    ) -> Result<crate::SessionDeleteResult> {
        let value: Value = read_json(
            self.request(
                "v1/sessions/delete",
                Some(&serde_json::to_value(request)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::sessions::deletion(value, request)
    }
    pub async fn report_tool_progress(
        &self,
        identity: &crate::ToolExecutionIdentity,
    ) -> Result<crate::ToolExecutionReceipt> {
        let value: Value = read_json(
            self.request(
                "v1/tool-executions/progress",
                Some(&serde_json::to_value(identity)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::application_tools::receipt(value, identity, crate::ToolExecutionStatus::Progress)
    }
    pub async fn complete_tool(
        &self,
        result: &crate::ToolExecutionResult,
    ) -> Result<crate::ToolExecutionReceipt> {
        let value: Value = read_json(
            self.request(
                "v1/tool-executions/results",
                Some(&serde_json::to_value(result)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::application_tools::receipt(
            value,
            result.identity(),
            crate::ToolExecutionStatus::Accepted,
        )
    }
    pub async fn decide_approval(
        &self,
        decision: &crate::ApprovalDecision,
    ) -> Result<crate::ApprovalResolution> {
        let value: Value = read_json(
            self.request(
                "v1/approvals/decisions",
                Some(&serde_json::to_value(decision)?),
                false,
            )
            .await?,
        )
        .await?;
        crate::approvals::receipt(value, decision)
    }
    pub async fn run(&self, request: &RunRequest) -> Result<RunResult> {
        if !request.application_tools.is_empty() {
            return Err(protocol_error(
                "TOOL_STREAM_REQUIRED",
                "Use stream to execute application-owned tools.",
            ));
        }
        if request.approvals.is_some() {
            return Err(protocol_error(
                "APPROVAL_STREAM_REQUIRED",
                "Use stream to receive and decide interactive approvals.",
            ));
        }
        let result: RunResult = read_json(
            self.request("v1/runs", Some(&serde_json::to_value(request)?), false)
                .await?,
        )
        .await?;
        if !validation::result_valid(&result, request) {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "The driver returned an invalid run result.",
            ));
        }
        Ok(result)
    }
    /// Open a stream. Dropping it, or a pending `next()` future, closes its response.
    pub async fn stream(&self, request: &RunRequest) -> Result<EventStream> {
        let response = self
            .request("v1/runs", Some(&serde_json::to_value(request)?), true)
            .await?;
        crate::transport::check_sse(response.headers())?;
        // Retain only fields needed to verify the host's selection, not the prompt/attachments.
        let mut selection = RunRequest::new(&request.provider, &request.model, "");
        selection.retrieval.clone_from(&request.retrieval);
        selection.session.clone_from(&request.session);
        selection.approvals.clone_from(&request.approvals);
        selection
            .application_tools
            .clone_from(&request.application_tools);
        selection.tools.clone_from(&request.tools);
        Ok(EventStream {
            state: Some(StreamState {
                response,
                request: selection,
                decoder: crate::events::EventDecoder::default(),
                bytes: VecDeque::new(),
                line: Vec::new(),
                skip_lf: false,
                first_line: true,
            }),
        })
    }
}

/// An owned, backpressured event stream. No worker thread or background reader.
///
/// Failure/cancellation terminal events are delivered as `Event`s; inspect `payload()`.
/// Transport/wire failures return `Err` once, then `None`. Completion closes immediately.
/// Cancelling a polled `next()` future closes the entire stream; it cannot be resumed.
#[must_use = "A stream must be consumed to receive its result; dropping it cancels the request"]
pub struct EventStream {
    state: Option<StreamState>,
}
struct StreamState {
    response: Response,
    request: RunRequest,
    decoder: crate::events::EventDecoder,
    bytes: VecDeque<u8>,
    line: Vec<u8>,
    skip_lf: bool,
    first_line: bool,
}
impl EventStream {
    /// Close immediately; dropping the stream has the same network effect.
    pub fn close(&mut self) {
        self.state.take();
    }
    pub fn is_closed(&self) -> bool {
        self.state.is_none()
    }

    /// Receive one event. With `tokio::select!`, losing this branch closes the stream
    /// if the future was polled. Create it again only when intentionally starting a run.
    pub async fn next(&mut self) -> Option<Result<Event>> {
        // The future owns the response and all parser buffers across await points.
        // Cancellation drops them even if the caller retains the now-closed stream.
        let mut state = self.state.take()?;
        let result = state.read_event().await;
        if result.as_ref().is_ok_and(|event| !event.is_terminal()) {
            self.state = Some(state);
        }
        Some(result)
    }
}
impl StreamState {
    async fn read_event(&mut self) -> Result<Event> {
        loop {
            while let Some(byte) = self.bytes.pop_front() {
                if self.skip_lf {
                    self.skip_lf = false;
                    if byte == b'\n' {
                        continue;
                    }
                }
                if byte == b'\r' || byte == b'\n' {
                    self.skip_lf = byte == b'\r';
                    let raw = std::mem::take(&mut self.line);
                    let raw = if self.first_line {
                        self.first_line = false;
                        raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&raw)
                    } else {
                        &raw
                    };
                    let line = std::str::from_utf8(raw).map_err(|_| {
                        protocol_error("INVALID_STREAM", "The event stream is not valid UTF-8.")
                    })?;
                    if let Some(event) = self.decoder.line(line, &self.request)? {
                        return Ok(event);
                    }
                } else {
                    self.line.push(byte);
                    if self.line.len() > validation::MAX_BYTES {
                        return Err(protocol_error(
                            "RESPONSE_TOO_LARGE",
                            "An event exceeded 2 MB.",
                        ));
                    }
                }
            }
            let Some(chunk) = self.response.chunk().await? else {
                // EOF does not dispatch a partial frame, but invalid UTF-8 still fails.
                std::str::from_utf8(&self.line).map_err(|_| {
                    protocol_error("INVALID_STREAM", "The event stream is not valid UTF-8.")
                })?;
                return Err(protocol_error(
                    "INCOMPLETE_STREAM",
                    "Connection closed before a terminal run event.",
                ));
            };
            self.bytes.extend(chunk.iter().copied());
        }
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(mut response: Response) -> Result<T> {
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if data.len() + chunk.len() > validation::MAX_BYTES {
            return Err(protocol_error(
                "RESPONSE_TOO_LARGE",
                "Response exceeded 2 MB.",
            ));
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| {
        protocol_error(
            "INVALID_RESPONSE",
            "The driver returned invalid JSON or an invalid response shape.",
        )
    })
}
