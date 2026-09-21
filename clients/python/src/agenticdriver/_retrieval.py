from ._ingestion import valid_ingestion
import math
import re
from ._context import _id, _digest, _string, _source

def valid_retrieval(value, request=None):
    if not isinstance(value, dict) or not _id(value.get("corpus")) or type(value.get("truncated")) is not bool:
        return False
    index, hits = value.get("index"), value.get("hits")
    if (not isinstance(index, dict) or not all(_id(index.get(k)) for k in ("providerId", "vendor", "accountId", "version")) or
            index.get("authMode") not in ("api-key", "none") or index.get("metric") != "cosine" or
            type(index.get("dimensions")) is not int or not 1 <= index["dimensions"] <= 4096 or
            not isinstance(index.get("model"), str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}", index["model"]) or
            not isinstance(hits, list) or len(hits) > 16):
        return False
    ids, size = set(), 0
    for hit in hits:
        if not isinstance(hit, dict) or not _id(hit.get("chunkId")) or hit["chunkId"] in ids or not _digest(hit.get("documentSha256")) or not _string(hit.get("text"), 16384, False):
            return False
        if "ingestion" in hit and not valid_ingestion(hit["ingestion"]):
            return False
        source, score = hit.get("source"), hit.get("score")
        if (not isinstance(source, dict) or not _source({**source, "mediaType": "text/plain", "bytes": 1, "sha256": "0"*64, "origin": "inline"}, lambda _: False) or
                type(score) not in (int, float) or not -1 <= score <= 1 or not math.isfinite(score)):
            return False
        try:
            size += len(hit["text"].encode("utf-8"))
        except UnicodeError:
            return False
        if request is not None and (("sourceIds" in request and source["id"] not in request["sourceIds"]) or score < request.get("minScore", -1)):
            return False
        ids.add(hit["chunkId"])
    return request is None or (value["corpus"] == request["corpus"] and len(hits) <= request.get("limit", 8) and size <= request.get("maxContextBytes", 65536))

def valid_retrieval_links(value, request):
    result = value.get("retrieval")
    if ("retrieval" in value) != ("retrieval" in request):
        return False
    if "retrieval" in value and not valid_retrieval(result, request["retrieval"]):
        return False
    hits = result["hits"] if result is not None else []
    sources = [source for source in value.get("sources", []) if source["origin"] == "retrieval"]
    return len(sources) == len(hits) and all(any(source["id"] == hit["chunkId"] and source["revision"] == hit["source"]["revision"] and
        source.get("location", {}).get("documentId") == hit["source"]["id"] and source["bytes"] == len(hit["text"].encode("utf-8")) for source in sources) for hit in hits)

def valid_index_result(value, request):
    return (isinstance(value, dict) and value.get("corpus") == request["corpus"] and value.get("sourceId") == request["source"]["id"] and
            value.get("revision") == request["source"]["revision"] and _digest(value.get("documentSha256")) and
            type(value.get("chunks")) is int and 1 <= value["chunks"] <= 256 and value.get("status") in ("indexed", "unchanged") and
            ("ingestion" not in value or (valid_ingestion(value["ingestion"]) and value["ingestion"]["chunks"] == value["chunks"])))

def valid_delete_result(value, request):
    return isinstance(value, dict) and all(value.get(k) == request[k] for k in ("corpus", "sourceId", "revision")) and type(value.get("deleted")) is bool
