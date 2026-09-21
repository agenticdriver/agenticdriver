"""Validate known context metadata without resolving app references on the client."""
import re
from urllib.parse import urlsplit

MEDIA = {"text/plain", "text/markdown", "image/png", "image/jpeg", "image/webp", "application/pdf"}
ARTIFACT_MEDIA = {"text/plain", "text/markdown", "application/json"}

def _string(value, limit, empty=True):
    return isinstance(value, str) and (empty or bool(value)) and len(value.encode("utf-16-le", errors="surrogatepass")) // 2 <= limit

def _id(value):
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}", value) is not None

def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None

def _location(value):
    if not isinstance(value, dict):
        return False
    if any(k in value and not _id(value[k]) for k in ("documentId", "threadId", "messageId")):
        return False
    if "section" in value and not _string(value["section"], 256):
        return False
    for key in ("page", "pageEnd", "startLine", "endLine"):
        if key in value and (type(value[key]) is not int or not 1 <= value[key] <= 1_000_000):
            return False
    return all(end not in value or (start in value and value[end] >= value[start]) for start, end in (("page", "pageEnd"), ("startLine", "endLine")))

def _source(value, timestamp):
    if not isinstance(value, dict) or not _id(value.get("id")) or not _id(value.get("revision")):
        return False
    if "title" in value and not _string(value["title"], 256):
        return False
    if "uri" in value:
        uri = value["uri"]
        if not _string(uri, 2048, False) or not re.match(r"^(https|app)://[^\s]+$", uri):
            return False
        try:
            parts = urlsplit(uri)
            if parts.username is not None or parts.password is not None:
                return False
        except ValueError:
            return False
    if "location" in value and not _location(value["location"]):
        return False
    return (isinstance(value.get("mediaType"), str) and value["mediaType"] in MEDIA and type(value.get("bytes")) is int and 0 < value["bytes"] <= 33_554_432
            and _digest(value.get("sha256")) and value.get("origin") in ("inline", "reference", "retrieval")
            and ("expiresAt" not in value or timestamp(value["expiresAt"])))

def valid_context_result(value, timestamp):
    sources, artifacts = value.get("sources", []), value.get("artifacts", [])
    if not isinstance(sources, list) or len(sources) > 16 or not all(_source(source, timestamp) for source in sources):
        return False
    ids = {source["id"] for source in sources}
    if len(ids) != len(sources) or not isinstance(artifacts, list) or len(artifacts) > 1:
        return False
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            return False
        name, aid = artifact.get("name"), artifact.get("id")
        if (not _string(name, 128, False) or name in (".", "..") or re.search(r"[/\\\x00-\x1f]", name)
                or not isinstance(aid, str) or re.fullmatch(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", aid) is None
                or artifact.get("status") != "draft" or not isinstance(artifact.get("mediaType"), str) or artifact["mediaType"] not in ARTIFACT_MEDIA
                or not _string(artifact.get("content"), 262_144) or not _digest(artifact.get("sha256"))):
            return False
        references = artifact.get("sourceIds")
        if not isinstance(references, list) or len(references) > 16 or not all(_id(sid) and sid in ids for sid in references) or len(set(references)) != len(references):
            return False
    return True

def valid_media_catalog(value):
    return (isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, list) and len(v) <= 6
            and all(isinstance(m, str) and m in MEDIA for m in v) for k, v in value.items()))
