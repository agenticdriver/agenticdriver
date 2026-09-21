"""Validate extraction coverage before exposing it as citation provenance."""
from ._context import _digest, _id, _string

def _integer(value, low, high):
    return type(value) is int and low <= value <= high

def _fields(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= value.keys() <= set(required) | set(optional)

def _identity(value):
    return _fields(value, ("id", "version")) and _id(value["id"]) and _string(value["version"], 128, False)

def valid_ingestion(value):
    if not _fields(value, ("format", "inputSha256", "inputBytes", "extractor", "chunker", "extractedTextBytes", "indexedTextBytes", "chunks"), ("ocrExtractor", "pages", "messages")):
        return False
    if (value["format"] not in ("text", "markdown", "pdf", "email") or not _digest(value["inputSha256"]) or
            not _integer(value["inputBytes"], 1, 33554432) or not _identity(value["extractor"]) or
            not _integer(value["extractedTextBytes"], 1, 1048576) or not _integer(value["indexedTextBytes"], 1, value["extractedTextBytes"]) or
            not _integer(value["chunks"], 1, 256)):
        return False
    chunker = value["chunker"]
    if not _fields(chunker, ("id", "maxBytes")) or chunker["id"] != "source-lines-v1" or not _integer(chunker["maxBytes"], 128, 16384):
        return False
    if value["format"] == "pdf":
        pages = value.get("pages")
        if not _fields(pages, ("total", "ocr", "empty")) or not _integer(pages["total"], 1, 1000):
            return False
        for key in ("ocr", "empty"):
            values = pages[key]
            if not isinstance(values, list) or len(values) > 1000 or not all(_integer(p, 1, pages["total"]) for p in values) or len(set(values)) != len(values):
                return False
        if len(pages["empty"]) >= pages["total"] or value["chunks"] < pages["total"] - len(pages["empty"]):
            return False
        if ("ocrExtractor" in value) != bool(pages["ocr"]) or ("ocrExtractor" in value and not _identity(value["ocrExtractor"])):
            return False
    elif "pages" in value or "ocrExtractor" in value:
        return False
    if value["format"] == "email":
        messages = value.get("messages")
        if not _fields(messages, ("total", "empty")) or not _integer(messages["total"], 1, 1000) or not _integer(messages["empty"], 0, messages["total"] - 1) or value["chunks"] < messages["total"] - messages["empty"]:
            return False
    elif "messages" in value:
        return False
    return True
