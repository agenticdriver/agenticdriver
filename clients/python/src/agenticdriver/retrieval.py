"""Scoped retrieval over app-authorized sources; vector data stays on the host."""
from typing import Literal, TypedDict
from .context import ContextSource, SourceLocation
from .ingestion import IngestionManifest

class _IngestionOptional(TypedDict, total=False):
    ingestion: IngestionManifest

class _Corpus(TypedDict):
    corpus: str

class _RetrievalOptions(_Corpus, total=False):
    sourceIds: list[str]
    limit: int
    maxContextBytes: int
    minScore: float

class RetrievalRequest(_RetrievalOptions, total=False):
    query: str

class RetrievalSearch(_RetrievalOptions):
    query: str

class VectorIndex(TypedDict):
    providerId: str
    vendor: str
    accountId: str
    authMode: Literal["api-key", "none"]
    model: str
    dimensions: int
    metric: Literal["cosine"]
    version: str

class _Chunk(TypedDict):
    id: str
    text: str

class RetrievalChunk(_Chunk, total=False):
    location: SourceLocation

class RetrievalIndexRequest(_Corpus, _IngestionOptional):
    source: ContextSource
    chunks: list[RetrievalChunk]

class RetrievalHit(_IngestionOptional):
    chunkId: str
    source: ContextSource
    text: str
    score: float
    documentSha256: str

class RetrievalResult(_Corpus):
    index: VectorIndex
    hits: list[RetrievalHit]
    truncated: bool

class RetrievalIndexResult(_Corpus, _IngestionOptional):
    sourceId: str
    revision: str
    documentSha256: str
    chunks: int
    status: Literal["indexed", "unchanged"]

class RetrievalDelete(_Corpus):
    sourceId: str
    revision: str

class RetrievalDeleteResult(RetrievalDelete):
    deleted: bool
