use crate::{protocol_error, DriverError, Event, Result, RunResult, Usage};
#[cfg(any(feature = "blocking", feature = "async"))]
use crate::{validation, RunRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(any(feature = "blocking", feature = "async"))]
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressPhase {
    Model,
    Tool,
    Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: BTreeMap<String, Value>,
}

/// Typed view of an event. Envelope fields remain available on [`Event`].
#[derive(Debug)]
#[non_exhaustive]
pub enum EventPayload<'a> {
    ToolExecutionRequested {
        execution: crate::ToolExecutionRequest,
    },
    RunStarted {
        provider: &'a str,
        model: &'a str,
    },
    StepStarted {
        step: u64,
    },
    TextDelta {
        text: &'a str,
    },
    Progress {
        phase: ProgressPhase,
    },
    ApprovalRequested {
        approval: crate::ApprovalRequest,
    },
    ApprovalResolved {
        resolution: crate::ApprovalResolution,
    },
    ToolCalled {
        call: ToolCall,
    },
    ToolCompleted {
        call_id: &'a str,
        output: &'a Value,
    },
    UsageReported {
        step: u64,
        usage: Usage,
    },
    RunCompleted {
        result: &'a RunResult,
    },
    RunFailed {
        error: &'a DriverError,
    },
    RunCancelled {
        error: &'a DriverError,
    },
}

impl Event {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "run.completed" | "run.failed" | "run.cancelled"
        )
    }

    /// Extract a typed payload, retaining the original `extra` map for compatibility.
    /// Events received from either client have already passed wire validation.
    pub fn payload(&self) -> Result<EventPayload<'_>> {
        let invalid = || protocol_error("INVALID_STREAM", "Invalid event payload.");
        let text = |key| {
            self.extra
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(invalid)
        };
        let step = || {
            self.extra
                .get("step")
                .and_then(Value::as_u64)
                .ok_or_else(invalid)
        };
        let value = |key| self.extra.get(key).ok_or_else(invalid);
        Ok(match self.kind.as_str() {
            "run.started" => EventPayload::RunStarted {
                provider: text("provider")?,
                model: text("model")?,
            },
            "step.started" => EventPayload::StepStarted { step: step()? },
            "text.delta" => EventPayload::TextDelta {
                text: self.text.as_deref().ok_or_else(invalid)?,
            },
            "run.progress" => EventPayload::Progress {
                phase: serde_json::from_value(value("phase")?.clone()).map_err(|_| invalid())?,
            },
            "tool.execution.requested" => EventPayload::ToolExecutionRequested {
                execution: serde_json::from_value(value("execution")?.clone())
                    .map_err(|_| invalid())?,
            },
            "approval.requested" => EventPayload::ApprovalRequested {
                approval: serde_json::from_value(value("approval")?.clone())
                    .map_err(|_| invalid())?,
            },
            "approval.resolved" => EventPayload::ApprovalResolved {
                resolution: serde_json::from_value(value("resolution")?.clone())
                    .map_err(|_| invalid())?,
            },
            "tool.called" => EventPayload::ToolCalled {
                call: serde_json::from_value(value("call")?.clone()).map_err(|_| invalid())?,
            },
            "tool.completed" => EventPayload::ToolCompleted {
                call_id: text("callId")?,
                output: value("output")?,
            },
            "usage.reported" => EventPayload::UsageReported {
                step: step()?,
                usage: serde_json::from_value(value("usage")?.clone()).map_err(|_| invalid())?,
            },
            "run.completed" => EventPayload::RunCompleted {
                result: self.result.as_ref().ok_or_else(invalid)?,
            },
            "run.failed" => EventPayload::RunFailed {
                error: self.error.as_ref().ok_or_else(invalid)?,
            },
            "run.cancelled" => EventPayload::RunCancelled {
                error: self.error.as_ref().ok_or_else(invalid)?,
            },
            _ => return Err(protocol_error("UNSUPPORTED_EVENT", "Unknown event type.")),
        })
    }
}

/// Shared frame bounds, sequence/identity validation and optional-event negotiation.
#[cfg(any(feature = "blocking", feature = "async"))]
#[derive(Default)]
pub(crate) struct EventDecoder {
    executions: BTreeSet<String>,
    execution_calls: BTreeSet<String>,
    fields: Vec<String>,
    size: usize,
    sequence: u64,
    run_id: String,
}

#[cfg(any(feature = "blocking", feature = "async"))]
impl EventDecoder {
    pub(crate) fn line(&mut self, line: &str, request: &RunRequest) -> Result<Option<Event>> {
        self.size += line.len();
        if self.size > validation::MAX_BYTES {
            return Err(protocol_error(
                "RESPONSE_TOO_LARGE",
                "An event exceeded 2 MB.",
            ));
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.fields
                .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
        }
        if !line.is_empty() {
            return Ok(None);
        }
        self.size = 0;
        if self.fields.is_empty() {
            return Ok(None);
        }
        let event: Event = serde_json::from_str(&self.fields.join("\n")).map_err(|_| {
            protocol_error(
                "INVALID_STREAM",
                "The event contained invalid JSON or an invalid payload.",
            )
        })?;
        self.fields.clear();
        if !validation::event_valid(&event, request, self.sequence == 0)
            || event.sequence != self.sequence + 1
            || (!self.run_id.is_empty() && self.run_id != event.run_id)
        {
            return Err(protocol_error(
                "INVALID_STREAM",
                "Invalid or out-of-order event.",
            ));
        }
        self.sequence = event.sequence;
        self.run_id.clone_from(&event.run_id);
        if event.kind == "tool.execution.requested" {
            if request.application_tools.is_empty() {
                return Err(protocol_error(
                    "UNSUPPORTED_EVENT",
                    "Application executors were not selected for this run.",
                ));
            }
            let execution: crate::ToolExecutionRequest =
                serde_json::from_value(event.extra["execution"].clone()).map_err(|_| {
                    protocol_error("INVALID_STREAM", "Invalid application invocation.")
                })?;
            if self.executions.len() >= 2048
                || !self.executions.insert(execution.execution_id)
                || !self.execution_calls.insert(execution.call.id)
            {
                return Err(protocol_error(
                    "INVALID_STREAM",
                    "An application tool invocation was repeated or exceeded the run bound.",
                ));
            }
        }
        if matches!(
            event.kind.as_str(),
            "approval.requested" | "approval.resolved"
        ) && request.approvals.is_none()
        {
            return Err(protocol_error(
                "UNSUPPORTED_EVENT",
                "Interactive approvals were not selected for this run.",
            ));
        }
        match event.kind.as_str() {
            "tool.execution.requested"
            | "approval.requested"
            | "approval.resolved"
            | "run.started"
            | "step.started"
            | "text.delta"
            | "run.progress"
            | "tool.called"
            | "tool.completed"
            | "usage.reported"
            | "run.completed"
            | "run.failed"
            | "run.cancelled" => Ok(Some(event)),
            _ if event.optional => Ok(None),
            _ => Err(protocol_error(
                "UNSUPPORTED_EVENT",
                "The host sent an unknown required event type.",
            )),
        }
    }
}
