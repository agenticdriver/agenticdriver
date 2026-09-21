//! Portable context metadata. Canonical source storage and artifact acceptance belong to the app.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContextInput {
    Text {
        source: ContextSource,
        #[serde(rename = "mediaType")]
        media_type: String,
        text: String,
    },
    Image {
        source: ContextSource,
        #[serde(rename = "mediaType")]
        media_type: String,
        data: String,
    },
    Pdf {
        source: ContextSource,
        #[serde(rename = "mediaType")]
        media_type: String,
        data: String,
    },
    Reference {
        id: String,
        revision: String,
        #[serde(rename = "mediaType")]
        media_type: String,
    },
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub id: String,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_end: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextManifest {
    #[serde(flatten)]
    pub source: ContextSource,
    pub media_type: String,
    pub bytes: u32,
    pub sha256: String,
    pub origin: String,
    pub expires_at: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequest {
    pub name: String,
    pub media_type: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftArtifact {
    pub name: String,
    pub media_type: String,
    pub id: String,
    pub status: String,
    pub content: String,
    pub sha256: String,
    pub source_ids: Vec<String>,
}
pub(crate) fn bounded(value: Option<&Value>, limit: usize, empty: bool) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| (empty || !s.is_empty()) && s.encode_utf16().count() <= limit)
}
pub(crate) fn id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    })
}
pub(crate) fn digest(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn media(value: Option<&Value>) -> bool {
    matches!(
        value.and_then(Value::as_str),
        Some(
            "text/plain"
                | "text/markdown"
                | "image/png"
                | "image/jpeg"
                | "image/webp"
                | "application/pdf"
        )
    )
}
fn positive(value: Option<&Value>, max: u64) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|n| n > 0 && n <= max)
}
pub(crate) fn source_valid(value: &Value) -> bool {
    let Some(source) = value.as_object() else {
        return false;
    };
    if !id(source.get("id"))
        || !id(source.get("revision"))
        || !digest(source.get("sha256"))
        || !media(source.get("mediaType"))
        || !positive(source.get("bytes"), 33_554_432)
        || !matches!(
            source.get("origin").and_then(Value::as_str),
            Some("inline" | "reference" | "retrieval")
        )
    {
        return false;
    }
    if source.contains_key("title") && !bounded(source.get("title"), 256, true) {
        return false;
    }
    if let Some(uri) = source.get("uri") {
        let Some(text) = uri.as_str() else {
            return false;
        };
        if !bounded(Some(uri), 2048, false)
            || text.chars().any(char::is_whitespace)
            || !(text.starts_with("https://") || text.starts_with("app://"))
        {
            return false;
        }
        let Ok(parsed) = reqwest::Url::parse(text) else {
            return false;
        };
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return false;
        }
    }
    if source.get("expiresAt").is_some_and(|value| {
        !value
            .as_str()
            .is_some_and(crate::validation::timestamp_valid)
    }) {
        return false;
    }
    if let Some(location) = source.get("location") {
        let Some(location) = location.as_object() else {
            return false;
        };
        for key in ["documentId", "threadId", "messageId"] {
            if location.contains_key(key) && !id(location.get(key)) {
                return false;
            }
        }
        if location.contains_key("section") && !bounded(location.get("section"), 256, true) {
            return false;
        }
        for key in ["page", "pageEnd", "startLine", "endLine"] {
            if location.contains_key(key) && !positive(location.get(key), 1_000_000) {
                return false;
            }
        }
        for (start, end) in [("page", "pageEnd"), ("startLine", "endLine")] {
            if let Some(end) = location.get(end) {
                if !location
                    .get(start)
                    .is_some_and(|start| start.as_u64() <= end.as_u64())
                {
                    return false;
                }
            }
        }
    }
    true
}
fn artifact_valid(value: &Value) -> bool {
    let Some(artifact) = value.as_object() else {
        return false;
    };
    if !bounded(artifact.get("name"), 128, false)
        || !bounded(artifact.get("content"), 262_144, true)
        || !digest(artifact.get("sha256"))
        || artifact.get("status").and_then(Value::as_str) != Some("draft")
        || !matches!(
            artifact.get("mediaType").and_then(Value::as_str),
            Some("text/plain" | "text/markdown" | "application/json")
        )
    {
        return false;
    }
    let name = artifact["name"].as_str().unwrap();
    if name == "." || name == ".." || name.chars().any(|c| c < ' ' || c == '/' || c == '\\') {
        return false;
    }
    let Some(uuid) = artifact.get("id").and_then(Value::as_str) else {
        return false;
    };
    if uuid.len() != 36
        || !uuid.bytes().enumerate().all(|(n, b)| {
            if [8, 13, 18, 23].contains(&n) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return false;
    }
    artifact
        .get("sourceIds")
        .and_then(Value::as_array)
        .is_some_and(|refs| refs.len() <= 16 && refs.iter().all(|value| id(Some(value))))
}
pub(crate) fn optional_sources<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Vec<ContextManifest>>, D::Error> {
    let value = Value::deserialize(d)?;
    if !value
        .as_array()
        .is_some_and(|sources| sources.len() <= 16 && sources.iter().all(source_valid))
    {
        return Err(serde::de::Error::custom("Invalid source manifests"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
pub(crate) fn optional_artifacts<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Vec<DraftArtifact>>, D::Error> {
    let value = Value::deserialize(d)?;
    if !value
        .as_array()
        .is_some_and(|artifacts| artifacts.len() <= 1 && artifacts.iter().all(artifact_valid))
    {
        return Err(serde::de::Error::custom("Invalid draft artifacts"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
pub(crate) fn optional_media<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<BTreeMap<String, Vec<String>>>, D::Error> {
    let value = Value::deserialize(d)?;
    if !value.as_object().is_some_and(|catalog| {
        catalog.values().all(|types| {
            types.as_array().is_some_and(|types| {
                types.len() <= 6 && types.iter().all(|value| media(Some(value)))
            })
        })
    }) {
        return Err(serde::de::Error::custom("Invalid input media catalog"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
pub(crate) fn relationships_valid(result: &crate::RunResult) -> bool {
    let sources = result.sources.as_deref().unwrap_or_default();
    let ids: std::collections::BTreeSet<_> =
        sources.iter().map(|source| &source.source.id).collect();
    ids.len() == sources.len()
        && result
            .artifacts
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|artifact| {
                let refs: std::collections::BTreeSet<_> = artifact.source_ids.iter().collect();
                refs.len() == artifact.source_ids.len() && refs.iter().all(|id| ids.contains(id))
            })
}
