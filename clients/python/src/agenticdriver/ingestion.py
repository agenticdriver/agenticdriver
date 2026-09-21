"""Bounded document ingestion; extraction and authorization happen on the host."""
from typing import Literal, TypedDict, Union
from .context import ContextReference, ContextSource, PdfAttachment, TextAttachment

class ExtractionIdentity(TypedDict):
    id: str
    version: str

class ChunkingOptions(TypedDict):
    maxBytes: int

class ChunkerInfo(ChunkingOptions):
    id: Literal["source-lines-v1"]

class PageCoverage(TypedDict):
    total: int
    ocr: list[int]
    empty: list[int]

class MessageCoverage(TypedDict):
    total: int
    empty: int

class _Manifest(TypedDict):
    format: Literal["text", "markdown", "pdf", "email"]
    inputSha256: str
    inputBytes: int
    extractor: ExtractionIdentity
    chunker: ChunkerInfo
    extractedTextBytes: int
    indexedTextBytes: int
    chunks: int

class IngestionManifest(_Manifest, total=False):
    ocrExtractor: ExtractionIdentity
    pages: PageCoverage
    messages: MessageCoverage

class EmailMessage(TypedDict):
    id: str
    text: str

class EmailDocument(TypedDict):
    type: Literal["email"]
    source: ContextSource
    threadId: str
    messages: list[EmailMessage]

IngestionDocument = Union[TextAttachment, PdfAttachment, ContextReference, EmailDocument]

class _IngestRequest(TypedDict):
    corpus: str
    document: IngestionDocument

class IngestRequest(_IngestRequest, total=False):
    chunking: ChunkingOptions
    idleTimeoutMs: int

class IngestResult(TypedDict):
    corpus: str
    sourceId: str
    revision: str
    documentSha256: str
    chunks: int
    status: Literal["indexed", "unchanged"]
    ingestion: IngestionManifest
