//! One-use host connection invitations; credentials are backend-only secrets.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGrant {
    pub subject: String,
    pub providers: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manage_providers: bool,
    #[serde(flatten)]
    pub permissions: BTreeMap<String, Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInvitation {
    pub grant: ConnectionGrant,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_lifetime_seconds: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub grant: ConnectionGrant,
    pub created_at: String,
    pub expires_at: String,
}
#[derive(Deserialize)]
pub struct ConnectionInvitation {
    #[serde(flatten)]
    pub info: ConnectionInfo,
    pub code: String,
}
#[derive(Deserialize)]
pub struct ConnectionCredentials {
    #[serde(flatten)]
    pub info: ConnectionInfo,
    pub token: String,
}
#[derive(Deserialize)]
pub struct ConnectionList {
    pub invitations: Vec<ConnectionInfo>,
    pub connections: Vec<ConnectionInfo>,
}

pub(crate) fn valid(info: &ConnectionInfo) -> bool {
    info.id.len() == 36
        && !info.grant.subject.is_empty()
        && !info.created_at.is_empty()
        && !info.expires_at.is_empty()
}
pub(crate) fn opaque(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub(crate) fn invalid() -> Error {
    Error::Protocol("Invalid connection metadata. Reconcile before retrying.")
}
pub(crate) fn invitation(value: Value) -> Result<ConnectionInvitation> {
    let parsed: ConnectionInvitation = serde_json::from_value(value).map_err(|_| invalid())?;
    if !valid(&parsed.info) || !opaque(&parsed.code) {
        return Err(invalid());
    }
    Ok(parsed)
}
pub(crate) fn credentials(value: Value) -> Result<ConnectionCredentials> {
    let parsed: ConnectionCredentials = serde_json::from_value(value).map_err(|_| invalid())?;
    if !valid(&parsed.info) || !opaque(&parsed.token) {
        return Err(invalid());
    }
    Ok(parsed)
}
pub(crate) fn list(value: Value) -> Result<ConnectionList> {
    let parsed: ConnectionList = serde_json::from_value(value).map_err(|_| invalid())?;
    if parsed.invitations.len() > 1000
        || parsed.connections.len() > 1000
        || !parsed
            .invitations
            .iter()
            .chain(&parsed.connections)
            .all(valid)
    {
        return Err(invalid());
    }
    Ok(parsed)
}

#[cfg(any(feature = "blocking", feature = "async"))]
pub fn connection_target(invitation: &str) -> Result<(String, String)> {
    use base64::Engine;
    let parts: Vec<&str> = invitation.trim().split('.').collect();
    if parts.len() != 3 || parts[0] != "ad1" || parts[1].len() > 8192 || !opaque(parts[2]) {
        return Err(invalid());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| invalid())?;
    let url = String::from_utf8(bytes).map_err(|_| invalid())?;
    let url = crate::transport::endpoint(&url, parts[2])?;
    Ok((url.to_string(), parts[2].to_owned()))
}
