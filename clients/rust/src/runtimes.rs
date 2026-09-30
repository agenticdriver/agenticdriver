//! Host-reviewed runtime installation is separate from sign-in and inference.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum ProviderRuntimeRequest {
    Status { kind: String },
    Install { kind: String },
    Cancel { kind: String, id: String },
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderRuntimeError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeInfo {
    pub kind: String,
    pub version: String,
    pub platform: String,
    pub phase: String,
    pub archive_sha256: String,
    pub download_bytes: u64,
    pub total_bytes: u64,
    pub can_cancel: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderRuntimeError>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderRuntimeSnapshot {
    pub version: u32,
    pub runtimes: Vec<ProviderRuntimeInfo>,
}
fn failure(code: &str, message: &str) -> Error {
    Error::Driver(crate::DriverError {
        code: code.into(),
        message: message.into(),
        retryable: false,
        outcome: None,
    })
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => (b'1'..=b'8').contains(&b),
            19 => b"89aAbB".contains(&b),
            _ => b.is_ascii_hexdigit(),
        })
}
fn text(s: &str, limit: usize) -> bool {
    !s.is_empty() && s.len() <= limit
}
pub(crate) fn validate_request(r: &ProviderRuntimeRequest) -> Result<()> {
    let valid = match r {
        ProviderRuntimeRequest::Status { kind } | ProviderRuntimeRequest::Install { kind } => {
            kind == "codex"
        }
        ProviderRuntimeRequest::Cancel { kind, id } => kind == "codex" && uuid(id),
    };
    if valid {
        Ok(())
    } else {
        Err(failure(
            "INVALID_RUNTIME_REQUEST",
            "Choose a supported runtime operation.",
        ))
    }
}
pub(crate) fn snapshot(
    value: Value,
    request: &ProviderRuntimeRequest,
) -> Result<ProviderRuntimeSnapshot> {
    let invalid = || {
        failure(
            "INVALID_RESPONSE",
            "The host returned invalid or mismatched runtime state.",
        )
    };
    let s: ProviderRuntimeSnapshot = serde_json::from_value(value).map_err(|_| invalid())?;
    if s.version != 1 || s.runtimes.len() != 1 {
        return Err(invalid());
    }
    let r = &s.runtimes[0];
    let active = matches!(r.phase.as_str(), "downloading" | "verifying");
    if r.kind != "codex"
        || r.version != "0.157.0"
        || r.platform != "linux-x64"
        || !matches!(
            r.phase.as_str(),
            "missing" | "downloading" | "verifying" | "installed" | "failed" | "cancelled"
        )
        || r.archive_sha256.len() != 64
        || !r
            .archive_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || r.total_bytes == 0
        || r.total_bytes > 9_007_199_254_740_991
        || r.download_bytes > r.total_bytes
        || matches!(r.phase.as_str(), "installed" | "verifying")
            && r.download_bytes != r.total_bytes
        || r.id.as_ref().is_some_and(|s| !uuid(s))
        || active && r.id.is_none()
        || r.can_cancel && !active
        || r.updated_at
            .as_ref()
            .is_some_and(|s| !crate::validation::timestamp_valid(s))
        || r.binary.as_ref().is_some_and(|s| !text(s, 4096))
        || (r.phase == "installed") != r.binary.is_some()
        || r.error
            .as_ref()
            .is_some_and(|e| !text(&e.code, 80) || !text(&e.message, 512))
        || matches!(request, ProviderRuntimeRequest::Cancel { id, .. } if r.id.as_ref() != Some(id))
    {
        return Err(invalid());
    }
    Ok(s)
}
