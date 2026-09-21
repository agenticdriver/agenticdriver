use crate::ToolCall;
use serde::{Deserialize, Serialize};
#[cfg(any(feature = "blocking", feature = "async"))]
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    Interactive,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalIdlePolicy {
    Pause,
    Continue,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPolicy {
    pub mode: ApprovalMode,
    pub idle_policy: ApprovalIdlePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_after_ms: Option<u32>,
}
impl ApprovalPolicy {
    /// No expiry unless the application explicitly sets `expires_after_ms`.
    pub fn interactive(idle_policy: ApprovalIdlePolicy) -> Self {
        Self {
            mode: ApprovalMode::Interactive,
            idle_policy,
            expires_after_ms: None,
        }
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub run_id: String,
    pub call: ToolCall,
    pub requested_at: String,
    pub expires_at: Option<String>,
    pub idle_policy: ApprovalIdlePolicy,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalAction {
    Approve,
    Deny,
    Cancel,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecision {
    pub approval_id: String,
    pub run_id: String,
    pub call: ToolCall,
    pub decision: ApprovalAction,
}
impl ApprovalRequest {
    pub fn decision(&self, decision: ApprovalAction) -> ApprovalDecision {
        ApprovalDecision {
            approval_id: self.approval_id.clone(),
            run_id: self.run_id.clone(),
            call: self.call.clone(),
            decision,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    Cancelled,
    Expired,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolution {
    pub approval_id: String,
    pub run_id: String,
    pub call_id: String,
    pub outcome: ApprovalOutcome,
    pub decided_at: String,
}

#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn approval_valid(value: &Value, request: &crate::RunRequest, run_id: &str) -> bool {
    let Ok(approval) = serde_json::from_value::<ApprovalRequest>(value.clone()) else {
        return false;
    };
    let mut chars = approval.call.name.chars();
    let name_valid = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    !approval.approval_id.is_empty()
        && approval.run_id == run_id
        && !approval.call.id.is_empty()
        && approval.call.id.encode_utf16().count() <= 256
        && name_valid
        && approval.call.name.len() <= 64
        && crate::validation::timestamp_valid(&approval.requested_at)
        && value
            .get("expiresAt")
            .is_none_or(|v| v.as_str().is_some_and(crate::validation::timestamp_valid))
        && request
            .approvals
            .as_ref()
            .is_none_or(|p| p.idle_policy == approval.idle_policy)
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn resolution_valid(value: &Value) -> bool {
    serde_json::from_value::<ApprovalResolution>(value.clone()).is_ok_and(|r| {
        !r.approval_id.is_empty()
            && !r.run_id.is_empty()
            && !r.call_id.is_empty()
            && crate::validation::timestamp_valid(&r.decided_at)
    })
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn receipt(
    value: Value,
    decision: &ApprovalDecision,
) -> crate::Result<ApprovalResolution> {
    let invalid = || {
        crate::protocol_error(
            "INVALID_RESPONSE",
            "The approval receipt does not match the decision; reconcile using the run stream.",
        )
    };
    if !resolution_valid(&value) {
        return Err(invalid());
    }
    let result: ApprovalResolution = serde_json::from_value(value).map_err(|_| invalid())?;
    let expected = match decision.decision {
        ApprovalAction::Approve => ApprovalOutcome::Approved,
        ApprovalAction::Deny => ApprovalOutcome::Denied,
        ApprovalAction::Cancel => ApprovalOutcome::Cancelled,
    };
    if result.approval_id != decision.approval_id
        || result.run_id != decision.run_id
        || result.call_id != decision.call.id
        || result.outcome != expected
    {
        return Err(invalid());
    }
    Ok(result)
}
