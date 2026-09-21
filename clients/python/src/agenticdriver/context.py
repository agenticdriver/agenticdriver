"""Portable, app-owned source references and draft artifacts; no implicit file or URL loading."""
from typing import Literal, TypedDict, Union

MediaType = Literal["text/plain", "text/markdown", "image/png", "image/jpeg", "image/webp", "application/pdf"]

class SourceLocation(TypedDict, total=False):
    documentId: str
    page: int
    pageEnd: int
    startLine: int
    endLine: int
    section: str
    threadId: str
    messageId: str

class _SourceRequired(TypedDict):
    id: str
    revision: str

class ContextSource(_SourceRequired, total=False):
    title: str
    uri: str
    location: SourceLocation

class TextAttachment(TypedDict):
    type: Literal["text"]
    source: ContextSource
    mediaType: Literal["text/plain", "text/markdown"]
    text: str

class ImageAttachment(TypedDict):
    type: Literal["image"]
    source: ContextSource
    mediaType: Literal["image/png", "image/jpeg", "image/webp"]
    data: str

class PdfAttachment(TypedDict):
    type: Literal["pdf"]
    source: ContextSource
    mediaType: Literal["application/pdf"]
    data: str

class ContextReference(TypedDict):
    type: Literal["reference"]
    id: str
    revision: str
    mediaType: MediaType

ContextInput = Union[TextAttachment, ImageAttachment, PdfAttachment, ContextReference]

class _ManifestRequired(ContextSource):
    mediaType: MediaType
    bytes: int
    sha256: str
    origin: Literal["inline", "reference", "retrieval"]

class ContextManifest(_ManifestRequired, total=False):
    expiresAt: str

class ArtifactRequest(TypedDict):
    name: str
    mediaType: Literal["text/plain", "text/markdown", "application/json"]

class DraftArtifact(ArtifactRequest):
    id: str
    status: Literal["draft"]
    content: str
    sha256: str
    sourceIds: list[str]
