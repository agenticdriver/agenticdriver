#![doc = include_str!("../README.md")]
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(feature = "blocking")]
pub mod blocking;
#[cfg(feature = "blocking")]
pub use blocking::AgenticClient;
#[cfg(feature = "async")]
mod async_client;
#[cfg(feature = "async")]
pub use async_client::{AsyncAgenticClient, EventStream};
pub mod context;
pub use context::{
    ArtifactRequest, ContextInput, ContextManifest, ContextSource, DraftArtifact, SourceLocation,
};
pub mod ingestion;
pub use ingestion::{
    ChunkingOptions, EmailMessage, ExtractionIdentity, IngestRequest, IngestResult,
    IngestionDocument, IngestionManifest,
};
pub mod approvals;
pub use approvals::{
    ApprovalAction, ApprovalDecision, ApprovalIdlePolicy, ApprovalMode, ApprovalOutcome,
    ApprovalPolicy, ApprovalRequest, ApprovalResolution,
};
mod events;
pub mod retrieval;
#[cfg(any(feature = "blocking", feature = "async"))]
mod transport;
mod validation;
pub use events::{EventPayload, ProgressPhase, ToolCall};
pub use retrieval::{
    RetrievalChunk, RetrievalDelete, RetrievalDeleteResult, RetrievalHit, RetrievalIndexRequest,
    RetrievalIndexResult, RetrievalRequest, RetrievalResult, RetrievalSearch, VectorIndex,
};

pub type Result<T> = std::result::Result<T, Error>;
pub const PROTOCOL_VERSION: &str = "1.0";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolInfo {
    pub protocol: String,
    pub version: String,
    pub supported_versions: Vec<String>,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DriverError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, deserialize_with = "validation::optional_outcome")]
    pub outcome: Option<ErrorOutcome>,
}
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ErrorOutcome {
    Uncertain,
}
#[derive(Debug)]
pub enum Error {
    Driver(DriverError),
    Http(reqwest::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    Protocol(&'static str),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Driver(e) => write!(f, "{}: {}", e.code, e.message),
            Self::Http(e) => write!(f, "{e}"),
            Self::Json(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "{e}"),
            Self::Protocol(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals: Option<ApprovalPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval: Option<RetrievalRequest>,
    pub provider: String,
    pub model: String,
    pub input: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ContextInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_artifact: Option<ArtifactRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_delay_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_delay_ms: Option<u32>,
}
impl RunRequest {
    pub fn new(
        provider: impl Into<String>,
        model: impl Into<String>,
        input: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            input: input.into(),
            ..Self::default()
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, deserialize_with = "validation::optional_count")]
    pub input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "validation::optional_count")]
    pub output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "validation::optional_count")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "validation::optional_count")]
    pub reasoning_tokens: Option<u64>,
    #[serde(default, deserialize_with = "validation::optional_cost")]
    pub cost_usd: Option<f64>,
    #[serde(default, deserialize_with = "validation::optional_cost")]
    pub api_equivalent_cost_usd: Option<f64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    #[serde(default, deserialize_with = "retrieval::optional_result")]
    pub retrieval: Option<RetrievalResult>,
    #[serde(default, deserialize_with = "context::optional_sources")]
    pub sources: Option<Vec<ContextManifest>>,
    #[serde(default, deserialize_with = "context::optional_artifacts")]
    pub artifacts: Option<Vec<DraftArtifact>>,
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub text: String,
    pub output: Option<Value>,
    pub usage: Usage,
    pub steps: u32,
    pub finish_reason: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub tools: bool,
    pub text_streaming: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    #[serde(default, deserialize_with = "context::optional_media")]
    pub input_media_types: Option<BTreeMap<String, Vec<String>>>,
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub auth_mode: String,
    pub models: Option<Vec<String>>,
    pub usage_stat_id: Option<String>,
    pub capabilities: Capabilities,
    #[serde(default, deserialize_with = "validation::optional_health")]
    pub health: Option<ProviderHealth>,
    #[serde(default, deserialize_with = "validation::optional_catalog")]
    pub model_catalog: Option<ModelCatalog>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub status: String,
    pub code: String,
    pub message: String,
    pub checked_at: String,
}
#[derive(Debug, Deserialize)]
pub struct ModelCatalog {
    pub source: String,
    pub models: Vec<String>,
    pub complete: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: String,
    pub run_id: String,
    pub sequence: u64,
    pub timestamp: String,
    #[serde(default)]
    pub optional: bool,
    pub text: Option<String>,
    pub result: Option<RunResult>,
    pub error: Option<DriverError>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn protocol_error(code: &str, message: &str) -> Error {
    Error::Driver(DriverError {
        code: code.into(),
        message: message.into(),
        retryable: false,
        outcome: None,
    })
}
