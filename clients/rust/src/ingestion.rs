//! Document extraction runs on the host. Inputs never select an executable or OCR service.
use crate::ContextSource;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum IngestionDocument {
    Text {
        source: ContextSource,
        #[serde(rename = "mediaType")]
        media_type: String,
        text: String,
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
    Email {
        source: ContextSource,
        #[serde(rename = "threadId")]
        thread_id: String,
        messages: Vec<EmailMessage>,
    },
}
impl IngestionDocument {
    pub(crate) fn identity(&self) -> (&str, &str) {
        match self {
            Self::Text { source, .. } | Self::Pdf { source, .. } | Self::Email { source, .. } => {
                (&source.id, &source.revision)
            }
            Self::Reference { id, revision, .. } => (id, revision),
        }
    }
}
#[derive(Debug, Serialize)]
pub struct EmailMessage {
    pub id: String,
    pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkingOptions {
    pub max_bytes: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRequest {
    pub corpus: String,
    pub document: IngestionDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunking: Option<ChunkingOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractionIdentity {
    pub id: String,
    pub version: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkerInfo {
    pub id: String,
    pub max_bytes: u32,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PageCoverage {
    pub total: u32,
    pub ocr: Vec<u32>,
    pub empty: Vec<u32>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageCoverage {
    pub total: u32,
    pub empty: u32,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestionManifest {
    pub format: String,
    pub input_sha256: String,
    pub input_bytes: u32,
    pub extractor: ExtractionIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_extractor: Option<ExtractionIdentity>,
    pub chunker: ChunkerInfo,
    pub extracted_text_bytes: u32,
    pub indexed_text_bytes: u32,
    pub chunks: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<PageCoverage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<MessageCoverage>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub corpus: String,
    pub source_id: String,
    pub revision: String,
    pub document_sha256: String,
    pub chunks: u32,
    pub status: String,
    pub ingestion: IngestionManifest,
}
fn fields(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|obj| {
        required.iter().all(|k| obj.contains_key(*k))
            && obj
                .keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    })
}
fn integer(value: Option<&Value>, low: u64, high: u64) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|n| n >= low && n <= high)
}
fn identity(value: &Value) -> bool {
    fields(value, &["id", "version"], &[])
        && crate::context::id(value.get("id"))
        && crate::context::bounded(value.get("version"), 128, false)
}
pub(crate) fn valid(value: &Value) -> bool {
    if !fields(
        value,
        &[
            "format",
            "inputSha256",
            "inputBytes",
            "extractor",
            "chunker",
            "extractedTextBytes",
            "indexedTextBytes",
            "chunks",
        ],
        &["ocrExtractor", "pages", "messages"],
    ) || !matches!(
        value["format"].as_str(),
        Some("text" | "markdown" | "pdf" | "email")
    ) || !crate::context::digest(value.get("inputSha256"))
        || !integer(value.get("inputBytes"), 1, 33554432)
        || !identity(&value["extractor"])
        || !integer(value.get("extractedTextBytes"), 1, 1048576)
        || !integer(
            value.get("indexedTextBytes"),
            1,
            value["extractedTextBytes"].as_u64().unwrap_or(0),
        )
        || !integer(value.get("chunks"), 1, 256)
    {
        return false;
    }
    let chunker = &value["chunker"];
    if !fields(chunker, &["id", "maxBytes"], &[])
        || chunker["id"].as_str() != Some("source-lines-v1")
        || !integer(chunker.get("maxBytes"), 128, 16384)
    {
        return false;
    }
    if value["format"] == "pdf" {
        let pages = &value["pages"];
        if !fields(pages, &["total", "ocr", "empty"], &[]) || !integer(pages.get("total"), 1, 1000)
        {
            return false;
        }
        let total = pages["total"].as_u64().unwrap();
        for key in ["ocr", "empty"] {
            let Some(entries) = pages[key].as_array() else {
                return false;
            };
            let mut seen = BTreeSet::new();
            if entries.len() > 1000
                || !entries
                    .iter()
                    .all(|p| integer(Some(p), 1, total) && seen.insert(p.as_u64().unwrap()))
            {
                return false;
            }
        }
        let empty = pages["empty"].as_array().unwrap().len() as u64;
        if empty >= total || value["chunks"].as_u64().unwrap() < total - empty {
            return false;
        }
        let has_ocr = !pages["ocr"].as_array().unwrap().is_empty();
        if value.get("ocrExtractor").is_some() != has_ocr
            || value.get("ocrExtractor").is_some_and(|v| !identity(v))
        {
            return false;
        }
    } else if value.get("pages").is_some() || value.get("ocrExtractor").is_some() {
        return false;
    }
    if value["format"] == "email" {
        let messages = &value["messages"];
        if !fields(messages, &["total", "empty"], &[])
            || !integer(messages.get("total"), 1, 1000)
            || !integer(
                messages.get("empty"),
                0,
                messages["total"].as_u64().unwrap() - 1,
            )
        {
            return false;
        }
        if value["chunks"].as_u64().unwrap()
            < messages["total"].as_u64().unwrap() - messages["empty"].as_u64().unwrap()
        {
            return false;
        }
    } else if value.get("messages").is_some() {
        return false;
    }
    true
}
pub(crate) fn optional<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<IngestionManifest>, D::Error> {
    let value = Value::deserialize(d)?;
    if !valid(&value) {
        return Err(serde::de::Error::custom("Invalid ingestion provenance"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}
