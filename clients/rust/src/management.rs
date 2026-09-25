//! Remote host administration, independently granted from execution access.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfiguration {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// None permits every explicit model; Some(vec![]) denies all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_ref: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_media_types: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_refs: Option<BTreeMap<String, Value>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementSnapshot {
    pub version: u32,
    pub revision: String,
    pub providers: Vec<ProviderConfiguration>,
    pub supported_kinds: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureProvider {
    pub revision: String,
    pub provider: ProviderConfiguration,
    /// Write only. Omit when keeping the existing credential reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}
pub(crate) fn snapshot(value: Value, id: Option<&str>) -> Result<ManagementSnapshot> {
    let parsed: ManagementSnapshot = serde_json::from_value(value)
        .map_err(|_| Error::Protocol("Invalid provider settings response."))?;
    let mut ids = std::collections::HashSet::new();
    if parsed.version != 1
        || parsed.revision.len() != 64
        || !parsed
            .revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || parsed.providers.len() > 32
        || parsed.supported_kinds.len() > 32
        || parsed
            .providers
            .iter()
            .any(|p| p.id.is_empty() || p.kind.is_empty() || !ids.insert(p.id.as_str()))
        || id.is_some_and(|id| !ids.contains(id))
    {
        return Err(Error::Protocol(
            "Invalid or mismatched provider settings. Refresh before retrying.",
        ));
    }
    Ok(parsed)
}
