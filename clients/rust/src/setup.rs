//! Native sign-in state owned by the authenticated connection. No provider tokens.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
fn failure(code: &str, message: &str) -> Error {
    Error::Driver(crate::DriverError {
        code: code.into(),
        message: message.into(),
        retryable: false,
        outcome: None,
    })
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSetupConfig {
    pub kind: String,
    pub id: String,
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_tools: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum ProviderSetupRequest {
    Start {
        revision: String,
        method: String,
        provider: ProviderSetupConfig,
    },
    List,
    Status {
        id: String,
    },
    Accept {
        id: String,
    },
    Cancel {
        id: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupInteraction {
    #[serde(rename = "type")]
    pub interaction_type: String,
    pub verification_url: String,
    pub user_code: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupAccount {
    pub email: Option<String>,
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderSetupError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupAttempt {
    pub id: String,
    pub provider_id: String,
    pub account_id: String,
    pub name: String,
    pub revision: String,
    pub method: String,
    pub phase: String,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction: Option<ProviderSetupInteraction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ProviderSetupAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderSetupError>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderSetupSnapshot {
    pub version: u32,
    pub attempts: Vec<ProviderSetupAttempt>,
}
fn text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max
}
fn instance(s: &str) -> bool {
    text(s, 80)
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn revision(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
pub(crate) fn validate_request(r: &ProviderSetupRequest) -> Result<()> {
    let valid = match r {
        ProviderSetupRequest::List => true,
        ProviderSetupRequest::Status { id }
        | ProviderSetupRequest::Accept { id }
        | ProviderSetupRequest::Cancel { id } => uuid(id),
        ProviderSetupRequest::Start {
            revision: rev,
            method,
            provider: p,
        } => {
            revision(rev)
                && method == "codex-device"
                && p.kind == "codex"
                && instance(&p.id)
                && instance(&p.account_id)
                && p.name.as_ref().is_none_or(|s| text(s, 100))
                && p.binary.as_ref().is_none_or(|s| text(s, 4096))
                && p.models.as_ref().is_none_or(|m| m.len() <= 1000)
                && p.application_tools.as_ref().is_none_or(|s| s == "mcp")
        }
    };
    if valid {
        Ok(())
    } else {
        Err(failure(
            "INVALID_SETUP_REQUEST",
            "Choose a supported provider setup operation.",
        ))
    }
}
pub(crate) fn snapshot(
    value: Value,
    request: &ProviderSetupRequest,
) -> Result<ProviderSetupSnapshot> {
    let invalid = || {
        failure(
            "INVALID_RESPONSE",
            "Invalid or mismatched provider setup state.",
        )
    };
    let parsed: ProviderSetupSnapshot = serde_json::from_value(value).map_err(|_| invalid())?;
    if parsed.version != 1 || parsed.attempts.len() > 32 {
        return Err(invalid());
    }
    let mut ids = std::collections::HashSet::new();
    for a in &parsed.attempts {
        if !uuid(&a.id)
            || !ids.insert(&a.id)
            || !instance(&a.provider_id)
            || !instance(&a.account_id)
            || !text(&a.name, 100)
            || !revision(&a.revision)
            || a.method != "codex-device"
            || !matches!(
                a.phase.as_str(),
                "starting"
                    | "waiting"
                    | "verifying"
                    | "ready"
                    | "succeeded"
                    | "failed"
                    | "cancelled"
                    | "expired"
            )
            || [&a.created_at, &a.updated_at, &a.expires_at]
                .iter()
                .any(|s| !crate::validation::timestamp_valid(s))
            || a.interaction.as_ref().is_some_and(|i| {
                i.interaction_type != "device-code"
                    || i.verification_url != "https://auth.openai.com/codex/device"
                    || !(4..=40).contains(&i.user_code.len())
                    || !i
                        .user_code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
            })
            || a.account.as_ref().is_some_and(|a| {
                !text(&a.plan, 80)
                    || a.email.as_ref().is_some_and(|s| s.len() > 320)
                    || a.provider_account_id
                        .as_ref()
                        .is_some_and(|s| !text(s, 256))
            })
            || a.error
                .as_ref()
                .is_some_and(|e| !text(&e.code, 80) || !text(&e.message, 512))
        {
            return Err(invalid());
        }
    }
    if !matches!(request, ProviderSetupRequest::List) {
        if parsed.attempts.len() != 1 {
            return Err(invalid());
        }
        let a = &parsed.attempts[0];
        let matched = match request {
            ProviderSetupRequest::Start {
                revision,
                method,
                provider,
            } => {
                &a.revision == revision
                    && &a.method == method
                    && a.provider_id == provider.id
                    && a.account_id == provider.account_id
            }
            ProviderSetupRequest::Status { id }
            | ProviderSetupRequest::Accept { id }
            | ProviderSetupRequest::Cancel { id } => &a.id == id,
            ProviderSetupRequest::List => true,
        };
        if !matched {
            return Err(invalid());
        }
    }
    Ok(parsed)
}
