"""AgenticDriver v1 clients. Verified HTTPS remotely; authenticated HTTP on loopback."""

from .client import AgenticClient, RunStream
from .async_client import AsyncAgenticClient, AsyncRunStream
from ._errors import DriverError
from ._protocol import PROTOCOL_VERSION

from .context import (
    ArtifactRequest,
    ContextInput,
    ContextManifest,
    ContextReference,
    ContextSource,
    DraftArtifact,
    ImageAttachment,
    MediaType,
    PdfAttachment,
    SourceLocation,
    TextAttachment,
)

__all__ = [
    "AgenticClient",
    "DriverError",
    "PROTOCOL_VERSION",
    "ArtifactRequest",
    "ContextInput",
    "ContextManifest",
    "ContextReference",
    "ContextSource",
    "DraftArtifact",
    "ImageAttachment",
    "MediaType",
    "PdfAttachment",
    "SourceLocation",
    "TextAttachment",
]

from .retrieval import (
    RetrievalRequest,
    RetrievalSearch,
    VectorIndex,
    RetrievalChunk,
    RetrievalIndexRequest,
    RetrievalHit,
    RetrievalResult,
    RetrievalIndexResult,
    RetrievalDelete,
    RetrievalDeleteResult,
)

from .jobs import JobState, JobSubmit, JobIdentity, JobEventsRequest, JobInfo, JobEventPage

__all__ += ["JobState", "JobSubmit", "JobIdentity", "JobEventsRequest", "JobInfo", "JobEventPage"]

__all__ += [
    "RetrievalRequest",
    "RetrievalSearch",
    "VectorIndex",
    "RetrievalChunk",
    "RetrievalIndexRequest",
    "RetrievalHit",
    "RetrievalResult",
    "RetrievalIndexResult",
    "RetrievalDelete",
    "RetrievalDeleteResult",
]

from .ingestion import (
    IngestRequest,
    IngestResult,
    IngestionDocument,
    IngestionManifest,
    EmailDocument,
    EmailMessage,
    ChunkingOptions,
    ExtractionIdentity,
)

__all__ += [
    "IngestRequest",
    "IngestResult",
    "IngestionDocument",
    "IngestionManifest",
    "EmailDocument",
    "EmailMessage",
    "ChunkingOptions",
    "ExtractionIdentity",
]

from .models import (
    Json,
    AuthMode,
    HistoryMessage,
    RetryPolicy,
    RunRequest,
    Usage,
    RunResult,
    ErrorInfo,
    ProviderHealth,
    ModelCatalog,
    ProviderInfo,
    ProtocolInfo,
    ToolCall,
    ApplicationToolDefinition,
    ToolExecutionIdentity,
    ToolExecutionRequest,
    ToolExecutionSuccess,
    ToolExecutionFailure,
    ToolExecutionResult,
    ToolExecutionReceipt,
    ToolExecutionRequested,
    ApprovalPolicy,
    ApprovalRequest,
    ApprovalDecision,
    ApprovalResolution,
    ApprovalRequested,
    ApprovalResolved,
    RunEvent,
    RunStarted,
    StepStarted,
    TextDelta,
    RunProgress,
    ToolCalled,
    ToolCompleted,
    UsageReported,
    RunCompleted,
    RunFailed,
    RunCancelled,
)

__all__ += [
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
    "ApplicationToolDefinition",
    "ToolExecutionIdentity",
    "ToolExecutionRequest",
    "ToolExecutionSuccess",
    "ToolExecutionFailure",
    "ToolExecutionResult",
    "ToolExecutionReceipt",
    "ToolExecutionRequested",
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
    "RunStream",
    "AsyncAgenticClient",
    "AsyncRunStream",
]

from .models import SessionMode, SessionIdentity, SessionHandle, SessionCreate, SessionInfo, SessionSnapshot, SessionDeleteResult
__all__ += ['SessionMode', 'SessionIdentity', 'SessionHandle', 'SessionCreate', 'SessionInfo', 'SessionSnapshot', 'SessionDeleteResult']

from .management import ProviderConfiguration, ConfigureProvider, ManagementSnapshot, ProviderDefinition, ProviderConnectionMethod
__all__ += ["ProviderConfiguration", "ConfigureProvider", "ManagementSnapshot", "ProviderDefinition", "ProviderConnectionMethod"]

from .connections import ConnectionGrant, CreateInvitation, ConnectionInfo, ConnectionInvitation, ConnectionCredentials, ConnectionList, connection_target
__all__ += ["ConnectionGrant", "CreateInvitation", "ConnectionInfo", "ConnectionInvitation", "ConnectionCredentials", "ConnectionList", "connection_target"]

from .panel import ProviderPanel, AsyncProviderPanel, provider_panel_html, provider_panel_script
__all__ += ["ProviderPanel", "AsyncProviderPanel", "provider_panel_html", "provider_panel_script"]
