"""Typed wire models. Optional measurements remain absent when unreported."""

from typing import Any, Literal, TypedDict, Union

from .context import (
    ArtifactRequest,
    ContextInput,
    ContextManifest,
    DraftArtifact,
    MediaType,
)
from .retrieval import RetrievalRequest, RetrievalSearch, RetrievalResult

Json = Union[None, bool, int, float, str, list["Json"], dict[str, "Json"]]
AuthMode = Literal["api-key", "cli-session", "none"]


class HistoryMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


class _Retry(TypedDict):
    maxAttempts: int


class RetryPolicy(_Retry, total=False):
    baseDelayMs: int
    maxDelayMs: int


class _RunRequest(TypedDict):
    provider: str
    model: str
    input: str


class RunRequest(_RunRequest, total=False):
    instructions: str
    history: list[HistoryMessage]
    attachments: list[ContextInput]
    retrieval: Union[RetrievalRequest, RetrievalSearch]
    outputArtifact: ArtifactRequest
    idempotencyKey: str
    retry: RetryPolicy
    approvals: "ApprovalPolicy"
    tools: list[str]
    requiredCapabilities: list[str]
    maxSteps: int
    maxOutputTokens: int
    idleTimeoutMs: int
    outputSchema: dict[str, Any]
    metadata: dict[str, str]


class Usage(TypedDict, total=False):
    inputTokens: int
    outputTokens: int
    cachedInputTokens: int
    reasoningTokens: int
    costUsd: float
    apiEquivalentCostUsd: float


class _Result(TypedDict):
    runId: str
    provider: str
    model: str
    text: str
    usage: Usage
    steps: int
    finishReason: Literal["stop", "length"]


class RunResult(_Result, total=False):
    output: Json
    sources: list[ContextManifest]
    artifacts: list[DraftArtifact]
    retrieval: RetrievalResult


class _Error(TypedDict):
    code: str
    message: str
    retryable: bool


class ErrorInfo(_Error, total=False):
    outcome: Literal["uncertain"]


class ProviderHealth(TypedDict):
    status: Literal["ready", "unauthenticated", "unavailable", "unsupported", "unknown"]
    code: str
    message: str
    checkedAt: str


class ModelCatalog(TypedDict):
    source: Literal["provider", "configured", "unavailable"]
    models: list[str]
    complete: bool


class _Provider(TypedDict):
    id: str
    name: str
    vendor: str
    authMode: AuthMode
    capabilities: dict[str, bool]


class ProviderInfo(_Provider, total=False):
    models: list[str]
    inputMediaTypes: dict[str, list[MediaType]]
    usageStatId: str
    health: ProviderHealth
    modelCatalog: ModelCatalog


class ProtocolInfo(TypedDict):
    protocol: Literal["agenticdriver"]
    version: str
    supportedVersions: list[str]
    features: list[str]


class ToolCall(TypedDict):
    id: str
    name: str
    arguments: dict[str, Json]


class _ApprovalPolicy(TypedDict):
    mode: Literal["interactive"]
    idlePolicy: Literal["pause", "continue"]


class ApprovalPolicy(_ApprovalPolicy, total=False):
    expiresAfterMs: int


class _ApprovalRequest(TypedDict):
    approvalId: str
    runId: str
    call: ToolCall
    requestedAt: str
    idlePolicy: Literal["pause", "continue"]


class ApprovalRequest(_ApprovalRequest, total=False):
    expiresAt: str


class ApprovalDecision(TypedDict):
    approvalId: str
    runId: str
    call: ToolCall
    decision: Literal["approve", "deny", "cancel"]


class ApprovalResolution(TypedDict):
    approvalId: str
    runId: str
    callId: str
    outcome: Literal["approved", "denied", "cancelled", "expired"]
    decidedAt: str


class _EventOptional(TypedDict, total=False):
    optional: bool


class _Event(_EventOptional):
    runId: str
    sequence: int
    timestamp: str


class RunStarted(_Event):
    type: Literal["run.started"]
    provider: str
    model: str


class StepStarted(_Event):
    type: Literal["step.started"]
    step: int


class TextDelta(_Event):
    type: Literal["text.delta"]
    text: str


class RunProgress(_Event):
    type: Literal["run.progress"]
    phase: Literal["model", "tool", "context"]


class ApprovalRequested(_Event):
    type: Literal["approval.requested"]
    approval: ApprovalRequest


class ApprovalResolved(_Event):
    type: Literal["approval.resolved"]
    resolution: ApprovalResolution


class ToolCalled(_Event):
    type: Literal["tool.called"]
    call: ToolCall


class ToolCompleted(_Event):
    type: Literal["tool.completed"]
    callId: str
    output: Json


class UsageReported(_Event):
    type: Literal["usage.reported"]
    step: int
    usage: Usage


class RunCompleted(_Event):
    type: Literal["run.completed"]
    result: RunResult


class RunFailed(_Event):
    type: Literal["run.failed"]
    error: ErrorInfo


class RunCancelled(_Event):
    type: Literal["run.cancelled"]
    error: ErrorInfo


RunEvent = Union[
    RunStarted,
    StepStarted,
    TextDelta,
    RunProgress,
    ApprovalRequested,
    ApprovalResolved,
    ToolCalled,
    ToolCompleted,
    UsageReported,
    RunCompleted,
    RunFailed,
    RunCancelled,
]

__all__ = [
    "Json",
    "AuthMode",
    "HistoryMessage",
    "RetryPolicy",
    "RunRequest",
    "Usage",
    "RunResult",
    "ErrorInfo",
    "ProviderHealth",
    "ModelCatalog",
    "ProviderInfo",
    "ProtocolInfo",
    "ToolCall",
    "ApprovalPolicy",
    "ApprovalRequest",
    "ApprovalDecision",
    "ApprovalResolution",
    "ApprovalRequested",
    "ApprovalResolved",
    "RunEvent",
    "RunStarted",
    "StepStarted",
    "TextDelta",
    "RunProgress",
    "ToolCalled",
    "ToolCompleted",
    "UsageReported",
    "RunCompleted",
    "RunFailed",
    "RunCancelled",
]
