//! Retrieval contracts: canonical sources and access decisions remain application-owned.
use crate::{ContextSource, SourceLocation};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalRequest {
    pub corpus: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_context_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_score: Option<f64>,
}
/// SearchContext requires query. Runs can use their input as the query.
pub type RetrievalSearch = RetrievalRequest;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorIndex {
    pub provider_id: String,
    pub vendor: String,
    pub account_id: String,
    pub auth_mode: String,
    pub model: String,
    pub dimensions: u32,
    pub metric: String,
    pub version: String,
}
#[derive(Debug, Serialize)]
pub struct RetrievalChunk {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
}
#[derive(Debug, Serialize)]
pub struct RetrievalIndexRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingestion: Option<crate::IngestionManifest>,
    pub corpus: String,
    pub source: ContextSource,
    pub chunks: Vec<RetrievalChunk>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalHit {
    #[serde(default, deserialize_with = "crate::ingestion::optional")]
    pub ingestion: Option<crate::IngestionManifest>,
    pub chunk_id: String,
    pub source: ContextSource,
    pub text: String,
    pub score: f64,
    pub document_sha256: String,
}
#[derive(Debug, Deserialize)]
pub struct RetrievalResult {
    pub corpus: String,
    pub index: VectorIndex,
    pub hits: Vec<RetrievalHit>,
    pub truncated: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalIndexResult {
    #[serde(default, deserialize_with = "crate::ingestion::optional")]
    pub ingestion: Option<crate::IngestionManifest>,
    pub corpus: String,
    pub source_id: String,
    pub revision: String,
    pub document_sha256: String,
    pub chunks: u32,
    pub status: String,
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalDelete {
    pub corpus: String,
    pub source_id: String,
    pub revision: String,
}
#[derive(Debug, Deserialize)]
pub struct RetrievalDeleteResult {
    #[serde(flatten)]
    pub request: RetrievalDelete,
    pub deleted: bool,
}

pub(crate) fn valid(value: &Value) -> bool {
    use crate::context::{bounded, digest, id, source_valid};
    let (Some(index), Some(hits)) = (
        value.get("index").and_then(Value::as_object),
        value.get("hits").and_then(Value::as_array),
    ) else {
        return false;
    };
    if !id(value.get("corpus"))
        || !value.get("truncated").is_some_and(Value::is_boolean)
        || hits.len() > 16
        || !["providerId", "vendor", "accountId", "version"]
            .iter()
            .all(|key| id(index.get(*key)))
        || !matches!(
            index.get("authMode").and_then(Value::as_str),
            Some("api-key" | "none")
        )
        || index.get("metric").and_then(Value::as_str) != Some("cosine")
        || !index
            .get("dimensions")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0 && n <= 4096)
    {
        return false;
    }
    let Some(model) = index.get("model").and_then(Value::as_str) else {
        return false;
    };
    if model.is_empty()
        || model.len() > 200
        || !model.as_bytes()[0].is_ascii_alphanumeric()
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
    {
        return false;
    }
    let mut ids = BTreeSet::new();
    for hit in hits {
        if !id(hit.get("chunkId"))
            || !ids.insert(hit["chunkId"].as_str().unwrap())
            || !digest(hit.get("documentSha256"))
            || !bounded(hit.get("text"), 16384, false)
            || !hit
                .get("score")
                .and_then(Value::as_f64)
                .is_some_and(|n| n.is_finite() && (-1.0..=1.0).contains(&n))
        {
            return false;
        }
        if hit
            .get("ingestion")
            .is_some_and(|v| !crate::ingestion::valid(v))
        {
            return false;
        }
        let Some(source) = hit.get("source").and_then(Value::as_object) else {
            return false;
        };
        let mut source = source.clone();
        source.insert("mediaType".into(), json!("text/plain"));
        source.insert("bytes".into(), json!(1));
        source.insert("origin".into(), json!("inline"));
        source.insert("sha256".into(), json!("0".repeat(64)));
        if !source_valid(&Value::Object(source)) {
            return false;
        }
    }
    true
}
pub(crate) fn optional_result<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<RetrievalResult>, D::Error> {
    let value = Value::deserialize(d)?;
    if !valid(&value) {
        return Err(serde::de::Error::custom("Invalid retrieval evidence"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn selection(
    result: Option<&RetrievalResult>,
    request: Option<&RetrievalRequest>,
) -> bool {
    match (result, request) {
        (None, None) => true,
        (Some(result), Some(request)) => {
            result.corpus == request.corpus
                && result.hits.len() <= request.limit.unwrap_or(8) as usize
                && result.hits.iter().all(|hit| {
                    (request.source_ids.is_empty() || request.source_ids.contains(&hit.source.id))
                        && hit.score >= request.min_score.unwrap_or(-1.0)
                })
                && result.hits.iter().map(|hit| hit.text.len()).sum::<usize>()
                    <= request.max_context_bytes.unwrap_or(65536) as usize
        }
        _ => false,
    }
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn links(result: &crate::RunResult) -> bool {
    let sources: Vec<_> = result
        .sources
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|source| source.origin == "retrieval")
        .collect();
    let hits = result
        .retrieval
        .as_ref()
        .map(|value| value.hits.as_slice())
        .unwrap_or_default();
    sources.len() == hits.len()
        && hits.iter().all(|hit| {
            sources.iter().any(|source| {
                source.source.id == hit.chunk_id
                    && source.source.revision == hit.source.revision
                    && source
                        .source
                        .location
                        .as_ref()
                        .and_then(|location| location.document_id.as_ref())
                        == Some(&hit.source.id)
                    && source.bytes as usize == hit.text.len()
            })
        })
}

#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn receipt(value: &Value, corpus: &str, id: &str, revision: &str) -> bool {
    value["corpus"].as_str() == Some(corpus)
        && value["sourceId"].as_str() == Some(id)
        && value["revision"].as_str() == Some(revision)
        && crate::context::digest(value.get("documentSha256"))
        && value["chunks"].as_u64().is_some_and(|n| n > 0 && n <= 256)
        && matches!(value["status"].as_str(), Some("indexed" | "unchanged"))
        && value
            .get("ingestion")
            .is_none_or(|v| crate::ingestion::valid(v) && v["chunks"] == value["chunks"])
}
