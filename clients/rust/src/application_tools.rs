use crate::ToolCall;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_approval: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionIdentity {
    pub execution_id: String,
    pub run_id: String,
    pub call_id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionRequest {
    pub execution_id: String,
    pub run_id: String,
    pub call: ToolCall,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApplicationToolFailure {
    #[serde(rename = "APPLICATION_TOOL_FAILED")]
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolExecutionResult {
    Success {
        #[serde(flatten)]
        identity: ToolExecutionIdentity,
        output: Value,
    },
    Failure {
        #[serde(flatten)]
        identity: ToolExecutionIdentity,
        error: ApplicationToolFailure,
    },
}
impl ToolExecutionResult {
    pub fn identity(&self) -> &ToolExecutionIdentity {
        match self {
            Self::Success { identity, .. } | Self::Failure { identity, .. } => identity,
        }
    }
}
impl ToolExecutionRequest {
    pub fn identity(&self) -> ToolExecutionIdentity {
        ToolExecutionIdentity {
            execution_id: self.execution_id.clone(),
            run_id: self.run_id.clone(),
            call_id: self.call.id.clone(),
        }
    }
    pub fn success(&self, output: Value) -> ToolExecutionResult {
        ToolExecutionResult::Success {
            identity: self.identity(),
            output,
        }
    }
    /// Reports a fixed public failure; never forwards a callback's private exception text.
    pub fn failure(&self) -> ToolExecutionResult {
        ToolExecutionResult::Failure {
            identity: self.identity(),
            error: ApplicationToolFailure::Failed,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutionStatus {
    Progress,
    Accepted,
}
#[derive(Debug, Clone, Deserialize)]
pub struct ToolExecutionReceipt {
    #[serde(flatten)]
    pub identity: ToolExecutionIdentity,
    pub status: ToolExecutionStatus,
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn execution_valid(value: &Value, request: &crate::RunRequest, run_id: &str) -> bool {
    let Ok(execution) = serde_json::from_value::<ToolExecutionRequest>(value.clone()) else {
        return false;
    };
    let bounded = |s: &str| !s.is_empty() && s.encode_utf16().count() <= 256;
    let mut chars = execution.call.name.chars();
    let name_valid = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    bounded(&execution.execution_id)
        && bounded(&execution.run_id)
        && bounded(&execution.call.id)
        && execution.run_id == run_id
        && name_valid
        && execution.call.name.len() <= 64
        && (request.application_tools.is_empty()
            || (request
                .application_tools
                .iter()
                .any(|d| d.name == execution.call.name)
                && request.tools.contains(&execution.call.name)))
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn receipt(
    value: Value,
    identity: &ToolExecutionIdentity,
    status: ToolExecutionStatus,
) -> crate::Result<ToolExecutionReceipt> {
    let invalid = || {
        crate::protocol_error(
            "INVALID_RESPONSE",
            "The tool receipt does not match its submission; reconcile the originating run.",
        )
    };
    let receipt: ToolExecutionReceipt = serde_json::from_value(value).map_err(|_| invalid())?;
    let bounded = |s: &str| !s.is_empty() && s.encode_utf16().count() <= 256;
    if &receipt.identity != identity
        || receipt.status != status
        || !bounded(&receipt.identity.execution_id)
        || !bounded(&receipt.identity.run_id)
        || !bounded(&receipt.identity.call_id)
    {
        return Err(invalid());
    }
    Ok(receipt)
}
