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
