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
    pub application_tools: Option<String>,
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
/// Setup metadata only, not account availability or an execution grant.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionMethod {
    pub id: String,
    pub label: String,
    pub description: String,
    pub interaction: String,
    pub credential_owner: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub kind: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub protocol: String,
    pub methods: Vec<ProviderConnectionMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirements: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementSnapshot {
    pub version: u32,
    pub revision: String,
    pub providers: Vec<ProviderConfiguration>,
    pub supported_kinds: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_definitions: Option<Vec<ProviderDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_providers: Option<Vec<String>>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureProvider {
    pub revision: String,
    pub provider: ProviderConfiguration,
    /// Write only. Omit when keeping the existing credential reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}
fn valid_definition(d: &ProviderDefinition) -> bool {
    let text = |s: &str, max: usize| !s.is_empty() && s.len() <= max;
    text(&d.kind, 80)
        && text(&d.name, 100)
        && text(&d.description, 1000)
        && text(&d.protocol, 100)
        && matches!(
            d.category.as_str(),
            "native" | "api" | "compatible" | "fixture"
        )
        && (1..=8).contains(&d.methods.len())
        && d.requirements.as_ref().is_none_or(|s| text(s, 2000))
        && d.docs_url
            .as_ref()
            .is_none_or(|s| text(s, 2000) && s.starts_with("https://"))
        && d.methods.iter().all(|m| {
            text(&m.id, 80)
                && m.id.as_bytes()[0].is_ascii_lowercase()
                && m.id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && text(&m.label, 100)
                && text(&m.description, 1000)
                && text(&m.interaction, 80)
                && m.interaction.as_bytes()[0].is_ascii_lowercase()
                && m.interaction
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && matches!(
                    m.credential_owner.as_str(),
                    "native-runtime" | "host" | "none"
                )
        })
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
            .provider_definitions
            .as_ref()
            .is_some_and(|definitions| {
                definitions.len() > 32 || definitions.iter().any(|d| !valid_definition(d))
            })
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
