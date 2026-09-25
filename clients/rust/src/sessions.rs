use crate::Message;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    History,
    Native,
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Ready,
    Running,
    Interrupted,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionIdentity {
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionHandle {
    pub id: String,
    pub revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreate {
    pub provider: String,
    pub model: String,
    pub mode: SessionMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}
impl SessionCreate {
    pub fn new(provider: impl Into<String>, model: impl Into<String>, mode: SessionMode) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            mode,
            history: Vec::new(),
            instructions: None,
        }
    }
}
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub handle: SessionHandle,
    pub provider: String,
    pub model: String,
    pub mode: SessionMode,
    pub state: SessionState,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
}
impl SessionInfo {
    pub fn identity(&self) -> SessionIdentity {
        SessionIdentity {
            id: self.handle.id.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct SessionSnapshot {
    pub session: SessionInfo,
    pub history: Vec<Message>,
    pub instructions: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct SessionDeleteResult {
    pub id: String,
    pub deleted: bool,
}

fn id_valid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn name_valid(value: &str, model: bool) -> bool {
    !value.is_empty()
        && value.len() <= if model { 200 } else { 80 }
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b"._-".contains(&b) || (model && b":/[]".contains(&b))
        })
}
fn date_valid(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes()[19] == b'.'
        && value.ends_with('Z')
        && crate::validation::timestamp_valid(value)
}
fn info_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let text = |name: &str| object.get(name).and_then(Value::as_str).unwrap_or("");
    let valid = id_valid(text("id"))
        && object
            .get("revision")
            .and_then(Value::as_u64)
            .is_some_and(|n| n <= 9_007_199_254_740_991)
        && name_valid(text("provider"), false)
        && name_valid(text("model"), true)
        && matches!(text("mode"), "history" | "native")
        && date_valid(text("createdAt"))
        && date_valid(text("updatedAt"))
        && text("updatedAt") >= text("createdAt");
    valid
        && if text("state") == "running" {
            !object.contains_key("expiresAt")
        } else {
            matches!(text("state"), "ready" | "interrupted")
                && date_valid(text("expiresAt"))
                && text("expiresAt") > text("updatedAt")
        }
}
impl<'de> Deserialize<'de> for SessionInfo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if !info_valid(&value) {
            return Err(serde::de::Error::custom("Invalid conversation metadata"));
        }
        let text = |key: &str| value[key].as_str().unwrap_or("").to_owned();
        Ok(Self {
            handle: SessionHandle {
                id: text("id"),
                revision: value["revision"].as_u64().unwrap(),
            },
            provider: text("provider"),
            model: text("model"),
            mode: if text("mode") == "native" {
                SessionMode::Native
            } else {
                SessionMode::History
            },
            state: match text("state").as_str() {
                "running" => SessionState::Running,
                "interrupted" => SessionState::Interrupted,
                _ => SessionState::Ready,
            },
            created_at: text("createdAt"),
            updated_at: text("updatedAt"),
            expires_at: value.get("expiresAt").map(|_| text("expiresAt")),
        })
    }
}
pub(crate) fn optional_info<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<SessionInfo>, D::Error> {
    SessionInfo::deserialize(deserializer).map(Some)
}
#[cfg(any(feature = "blocking", feature = "async"))]
fn invalid() -> crate::Error {
    crate::protocol_error(
        "INVALID_RESPONSE",
        "The conversation response does not match its request.",
    )
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn snapshot(
    value: Value,
    create: Option<&SessionCreate>,
    identity: Option<&SessionIdentity>,
) -> crate::Result<SessionSnapshot> {
    let Some(history) = value.get("history").and_then(Value::as_array) else {
        return Err(invalid());
    };
    if history.len() > 100
        || history.iter().any(|message| {
            let Some(object) = message.as_object() else {
                return true;
            };
            object.len() != 2
                || !matches!(
                    object.get("role").and_then(Value::as_str),
                    Some("user" | "assistant")
                )
                || !object
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.encode_utf16().count() <= 100_000)
        })
        || value.get("instructions").is_some_and(|v| {
            !v.as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 100_000)
        })
    {
        return Err(invalid());
    }
    let result: SessionSnapshot = serde_json::from_value(value).map_err(|_| invalid())?;
    if let Some(request) = create {
        let info = &result.session;
        if info.provider != request.provider
            || info.model != request.model
            || info.mode != request.mode
            || info.state != SessionState::Ready
            || info.handle.revision != 0
            || result.history != request.history
            || result.instructions != request.instructions
        {
            return Err(invalid());
        }
    }
    if identity.is_some_and(|identity| identity.id != result.session.handle.id) {
        return Err(invalid());
    }
    Ok(result)
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn deletion(
    value: Value,
    request: &SessionIdentity,
) -> crate::Result<SessionDeleteResult> {
    let result: SessionDeleteResult = serde_json::from_value(value).map_err(|_| invalid())?;
    if !result.deleted || !id_valid(&result.id) || result.id != request.id {
        return Err(invalid());
    }
    Ok(result)
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn selection(result: &crate::RunResult, request: &crate::RunRequest) -> bool {
    match (&result.session, &request.session) {
        (None, None) => true,
        (Some(info), Some(expected)) => {
            info.handle.id == expected.id
                && expected.revision.checked_add(1) == Some(info.handle.revision)
                && info.provider == result.provider
                && info.model == result.model
                && info.state == SessionState::Ready
        }
        _ => false,
    }
}
