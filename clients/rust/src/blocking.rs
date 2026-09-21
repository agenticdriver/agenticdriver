//! Optional blocking transport. Use a blocking worker from an async runtime.
use crate::{
    ingestion, protocol_error, retrieval, validation, DriverError, Error, Event, IngestRequest,
    IngestResult, ProtocolInfo, Provider, Result, RetrievalDelete, RetrievalDeleteResult,
    RetrievalIndexRequest, RetrievalIndexResult, RetrievalResult, RetrievalSearch, RunRequest,
    RunResult, PROTOCOL_VERSION,
};
use reqwest::blocking::{Client as HttpClient, Response};
use serde::Deserialize;
use serde_json::Value;
use std::io::{BufReader, Read};
use std::time::Duration;

pub struct AgenticClient {
    base: reqwest::Url,
    token: String,
    http: HttpClient,
}
impl AgenticClient {
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
            .timeout(None)
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
    fn request(&self, path: &str, body: Option<&Value>, stream: bool) -> Result<Response> {
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
        let response = request.send()?;
        if !response.status().is_success() {
            #[derive(Deserialize)]
            struct Envelope {
                error: DriverError,
            }
            return match read_json::<Envelope>(response) {
                Ok(payload) => Err(Error::Driver(payload.error)),
                Err(_) => Err(Error::Protocol("The driver returned an HTTP error.")),
            };
        }
        crate::transport::check_version(response.headers())?;
        Ok(response)
    }
    pub fn ingest_context(&self, request: &IngestRequest) -> Result<IngestResult> {
        let value: Value = read_json(self.request(
            "v1/retrieval/ingest",
            Some(&serde_json::to_value(request)?),
            false,
        )?)?;
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
    pub fn search_context(&self, request: &RetrievalSearch) -> Result<RetrievalResult> {
        let value: Value = read_json(self.request(
            "v1/retrieval/search",
            Some(&serde_json::to_value(request)?),
            false,
        )?)?;
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
    pub fn index_context(&self, request: &RetrievalIndexRequest) -> Result<RetrievalIndexResult> {
        let value: Value = read_json(self.request(
            "v1/retrieval/index",
            Some(&serde_json::to_value(request)?),
            false,
        )?)?;
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
    pub fn delete_context(&self, request: &RetrievalDelete) -> Result<RetrievalDeleteResult> {
        let result: RetrievalDeleteResult = read_json(self.request(
            "v1/retrieval/delete",
            Some(&serde_json::to_value(request)?),
            false,
        )?)?;
        if &result.request != request {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "Mismatched deletion receipt.",
            ));
        }
        Ok(result)
    }
    pub fn protocol(&self) -> Result<ProtocolInfo> {
        let info: ProtocolInfo = read_json(self.request("v1/protocol", None, false)?)?;
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
    pub fn providers(&self) -> Result<Vec<Provider>> {
        self.provider_catalog(false)
    }
    pub fn refresh_providers(&self) -> Result<Vec<Provider>> {
        self.provider_catalog(true)
    }
    fn provider_catalog(&self, refresh: bool) -> Result<Vec<Provider>> {
        #[derive(Deserialize)]
        struct Catalog {
            providers: Vec<Provider>,
        }
        let path = if refresh {
            "v1/providers?refresh=true"
        } else {
            "v1/providers"
        };
        Ok(read_json::<Catalog>(self.request(path, None, false)?)?.providers)
    }
    pub fn report_tool_progress(
        &self,
        identity: &crate::ToolExecutionIdentity,
    ) -> Result<crate::ToolExecutionReceipt> {
        let value: Value = read_json(self.request(
            "v1/tool-executions/progress",
            Some(&serde_json::to_value(identity)?),
            false,
        )?)?;
        crate::application_tools::receipt(value, identity, crate::ToolExecutionStatus::Progress)
    }
    pub fn complete_tool(
        &self,
        result: &crate::ToolExecutionResult,
    ) -> Result<crate::ToolExecutionReceipt> {
        let value: Value = read_json(self.request(
            "v1/tool-executions/results",
            Some(&serde_json::to_value(result)?),
            false,
        )?)?;
        crate::application_tools::receipt(
            value,
            result.identity(),
            crate::ToolExecutionStatus::Accepted,
        )
    }
    pub fn decide_approval(
        &self,
        decision: &crate::ApprovalDecision,
    ) -> Result<crate::ApprovalResolution> {
        let value: Value = read_json(self.request(
            "v1/approvals/decisions",
            Some(&serde_json::to_value(decision)?),
            false,
        )?)?;
        crate::approvals::receipt(value, decision)
    }
    pub fn run(&self, request: &RunRequest) -> Result<RunResult> {
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
        let result: RunResult =
            read_json(self.request("v1/runs", Some(&serde_json::to_value(request)?), false)?)?;
        if !validation::result_valid(&result, request) {
            return Err(protocol_error(
                "INVALID_RESPONSE",
                "The driver returned an invalid run result.",
            ));
        }
        Ok(result)
    }
    /// Return false from `visit` to close the response and cancel an unfinished run.
    /// Use a blocking worker when calling this synchronous API from an async runtime.
    pub fn stream(&self, request: &RunRequest, mut visit: impl FnMut(Event) -> bool) -> Result<()> {
        let response = self.request("v1/runs", Some(&serde_json::to_value(request)?), true)?;
        crate::transport::check_sse(response.headers())?;
        let mut reader = validation::SseLines::new(BufReader::new(response));
        let mut decoder = crate::events::EventDecoder::default();
        loop {
            let line = reader.next_line()?.ok_or_else(|| {
                protocol_error(
                    "INCOMPLETE_STREAM",
                    "Connection closed before a terminal run event.",
                )
            })?;
            if let Some(event) = decoder.line(&line, request)? {
                let terminal = event.is_terminal();
                let failure = if matches!(event.kind.as_str(), "run.failed" | "run.cancelled") {
                    event.error.clone()
                } else {
                    None
                };
                if !visit(event) {
                    return Ok(());
                }
                if let Some(error) = failure {
                    return Err(Error::Driver(error));
                }
                if terminal {
                    return Ok(());
                }
            }
        }
    }
}
fn read_json<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let mut data = Vec::new();
    response.take(2_000_001).read_to_end(&mut data)?;
    if data.len() > 2_000_000 {
        return Err(protocol_error(
            "RESPONSE_TOO_LARGE",
            "Response exceeded 2 MB.",
        ));
    }
    serde_json::from_slice(&data).map_err(|_| {
        protocol_error(
            "INVALID_RESPONSE",
            "The driver returned invalid JSON or an invalid response shape.",
        )
    })
}
