"""Conversation replies contain visible history, never provider state."""

import re
from datetime import datetime


def session_id(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", value, re.IGNORECASE) is not None


def valid_session_info(value, timestamp):
    if not isinstance(value, dict):
        return False
    canonical = lambda text: isinstance(text, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", text) is not None and timestamp(text)
    valid = (session_id(value.get("id")) and type(value.get("revision")) is int and 0 <= value["revision"] <= 9_007_199_254_740_991 and
             isinstance(value.get("provider"), str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", value["provider"]) is not None and
             isinstance(value.get("model"), str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}", value["model"]) is not None and
             value.get("mode") in ("history", "native") and value.get("state") in ("ready", "running", "interrupted") and
             canonical(value.get("createdAt")) and canonical(value.get("updatedAt")))
    if not valid:
        return False
    created = datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
    updated = datetime.fromisoformat(value["updatedAt"].replace("Z", "+00:00"))
    if updated < created:
        return False
    if value["state"] == "running":
        return "expiresAt" not in value
    return canonical(value.get("expiresAt")) and datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00")) > updated


def valid_session_snapshot(value, request, operation, timestamp):
    if not isinstance(value, dict) or not valid_session_info(value.get("session"), timestamp):
        return False
    history, session = value.get("history"), value["session"]
    if not isinstance(history, list) or len(history) > 100 or any(
        not isinstance(message, dict) or set(message) != {"role", "content"} or message.get("role") not in ("user", "assistant") or
        not isinstance(message.get("content"), str) or len(message["content"].encode("utf-16-le", errors="surrogatepass")) > 200_000
        for message in history
    ):
        return False
    if "instructions" in value and (not isinstance(value["instructions"], str) or len(value["instructions"].encode("utf-16-le", errors="surrogatepass")) > 200_000):
        return False
    if operation == "read":
        return session["id"] == request["id"]
    return (all(session.get(key) == request.get(key) for key in ("provider", "model", "mode")) and session["revision"] == 0 and session["state"] == "ready" and
            history == request.get("history", []) and value.get("instructions") == request.get("instructions"))


def valid_session_delete(value, request):
    return isinstance(value, dict) and session_id(value.get("id")) and value["id"] == request["id"] and value.get("deleted") is True


def valid_session_result(value, request, timestamp):
    if "session" not in request:
        return "session" not in value
    session, expected = value.get("session"), request["session"]
    if not isinstance(session, dict):
        return False
    return (valid_session_info(session, timestamp) and session["id"] == expected["id"] and session["revision"] == expected["revision"] + 1 and
            session["provider"] == value["provider"] and session["model"] == value["model"] and session["state"] == "ready")
