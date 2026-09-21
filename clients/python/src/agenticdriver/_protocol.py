"""Validation and bounded SSE parsing shared by the Python client interfaces."""
import json
import math
import re
from datetime import datetime

from ._errors import DriverError
from ._retrieval import valid_retrieval_links
from ._context import valid_context_result, valid_media_catalog

PROTOCOL_VERSION = "1.0"
MAX_BYTES = 2_000_000
MAX_INTEGER = 9_007_199_254_740_991
EVENT_TYPES = {"approval.requested", "approval.resolved", "run.started", "step.started", "text.delta", "run.progress", "tool.called", "tool.completed", "usage.reported", "run.completed", "run.failed", "run.cancelled"}


def parse_json(data, code="INVALID_RESPONSE"):
    def invalid_constant(_value):
        raise ValueError("Non-finite JSON number")
    try:
        return json.loads(data, parse_constant=invalid_constant)
    except (ValueError, UnicodeError):
        raise DriverError(code, "The driver returned malformed JSON or invalid UTF-8.") from None


def text(value, empty=False):
    return isinstance(value, str) and (empty or bool(value))


def count(value, positive=False):
    return type(value) is int and (value > 0 if positive else value >= 0) and value <= MAX_INTEGER


def valid_usage(value):
    if not isinstance(value, dict):
        return False
    for key in ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]:
        if key in value and not count(value[key]):
            return False
    try:
        return all(type(value.get(key, 0)) in {int, float} and math.isfinite(value.get(key, 0)) and value.get(key, 0) >= 0
                   for key in ["costUsd", "apiEquivalentCostUsd"])
    except OverflowError:
        return False


def valid_error(value):
    return (isinstance(value, dict) and text(value.get("code")) and text(value.get("message"), True)
            and type(value.get("retryable")) is bool and ("outcome" not in value or value["outcome"] == "uncertain"))


def valid_result(value, request, run_id=None):
    return (isinstance(value, dict) and text(value.get("runId")) and
            (run_id is None or value["runId"] == run_id) and
            value.get("provider") == request["provider"] and value.get("model") == request["model"] and
            text(value.get("text"), True) and count(value.get("steps"), True) and
            value.get("finishReason") in ("stop", "length") and valid_usage(value.get("usage")) and valid_context_result(value, valid_timestamp) and valid_retrieval_links(value, request))


def valid_catalog(value):
    if not isinstance(value, dict) or not isinstance(value.get("providers"), list):
        return False
    for provider in value["providers"]:
        if (not isinstance(provider, dict) or not all(text(provider.get(k)) for k in ["id", "name", "vendor"]) or
                provider.get("authMode") not in ("api-key", "cli-session", "none")):
            return False
        capabilities = provider.get("capabilities")
        if (not isinstance(capabilities, dict) or not all(k in capabilities for k in ["tools", "textStreaming"]) or
                not all(type(v) is bool for v in capabilities.values())):
            return False
        if "models" in provider and (not isinstance(provider["models"], list) or not all(isinstance(v, str) for v in provider["models"])):
            return False
        if "inputMediaTypes" in provider and not valid_media_catalog(provider["inputMediaTypes"]):
            return False
        if "usageStatId" in provider and not isinstance(provider["usageStatId"], str):
            return False
        if "health" in provider:
            health = provider["health"]
            if (not isinstance(health, dict) or health.get("status") not in ("ready", "unauthenticated", "unavailable", "unsupported", "unknown") or
                    not text(health.get("code")) or not text(health.get("message"), True) or not valid_timestamp(health.get("checkedAt"))):
                return False
        if "modelCatalog" in provider:
            catalog = provider["modelCatalog"]
            if (not isinstance(catalog, dict) or catalog.get("source") not in ("provider", "configured", "unavailable") or
                    type(catalog.get("complete")) is not bool or not isinstance(catalog.get("models"), list) or
                    len(catalog["models"]) > 1000 or not all(isinstance(v, str) for v in catalog["models"])):
                return False
    return True


def valid_protocol(value):
    return (isinstance(value, dict) and value.get("protocol") == "agenticdriver" and value.get("version") == PROTOCOL_VERSION and
            isinstance(value.get("supportedVersions"), list) and PROTOCOL_VERSION in value["supportedVersions"] and
            all(isinstance(v, str) for v in value["supportedVersions"]) and isinstance(value.get("features"), list) and
            all(isinstance(v, str) for v in value["features"]))


def valid_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def valid_approval(value, run_id=None, policy=None):
    if not (isinstance(value, dict) and all(text(value.get(k)) for k in ["approvalId", "runId"]) and
            (run_id is None or value["runId"] == run_id) and valid_timestamp(value.get("requestedAt")) and
            value.get("idlePolicy") in ("pause", "continue") and
            (policy is None or value["idlePolicy"] == policy.get("idlePolicy")) and
            ("expiresAt" not in value or valid_timestamp(value["expiresAt"]))):
        return False
    call = value.get("call")
    return (isinstance(call, dict) and text(call.get("id")) and len(call["id"]) <= 256 and
            isinstance(call.get("name"), str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}", call["name"]) is not None and
            isinstance(call.get("arguments"), dict))


def valid_resolution(value, run_id=None, decision=None):
    valid = (isinstance(value, dict) and all(text(value.get(k)) for k in ["approvalId", "runId", "callId"]) and
             (run_id is None or value["runId"] == run_id) and valid_timestamp(value.get("decidedAt")) and
             value.get("outcome") in ("approved", "denied", "cancelled", "expired"))
    if valid and decision is not None:
        valid = (value["approvalId"] == decision["approvalId"] and value["runId"] == decision["runId"] and
                 value["callId"] == decision["call"]["id"] and
                 value["outcome"] == {"approve": "approved", "deny": "denied", "cancel": "cancelled"}.get(decision["decision"]))
    return valid


class EventDecoder:
    def __init__(self, request):
        self.request, self.sequence, self.run_id = request, 0, None

    def accept(self, event):
        valid = (isinstance(event, dict) and text(event.get("type")) and text(event.get("runId")) and
                 count(event.get("sequence"), True) and event["sequence"] == self.sequence + 1 and
                 (self.run_id is None or self.run_id == event["runId"]) and valid_timestamp(event.get("timestamp")) and
                 ("optional" not in event or type(event["optional"]) is bool) and
                 ((self.sequence == 0) == (event["type"] == "run.started")))
        if not valid:
            raise DriverError("INVALID_STREAM", "Invalid or out-of-order event envelope.")
        self.sequence, self.run_id = event["sequence"], event["runId"]
        kind = event["type"]
        if kind not in EVENT_TYPES:
            if event.get("optional") is not True:
                raise DriverError("UNSUPPORTED_EVENT", "The host sent an unknown required event type.")
            return None
        if kind.startswith("approval.") and not self.request.get("approvals"):
            raise DriverError("UNSUPPORTED_EVENT", "Interactive approvals were not selected for this run.")
        if kind == "approval.requested":
            valid = valid_approval(event.get("approval"), self.run_id, self.request.get("approvals"))
        elif kind == "approval.resolved":
            valid = valid_resolution(event.get("resolution"), self.run_id)
        elif kind == "run.started":
            valid = event.get("provider") == self.request["provider"] and event.get("model") == self.request["model"]
        elif kind == "step.started":
            valid = count(event.get("step"), True)
        elif kind == "text.delta":
            valid = text(event.get("text"), True)
        elif kind == "run.progress":
            valid = event.get("phase") in ("model", "tool", "context")
        elif kind == "tool.called":
            call = event.get("call")
            valid = isinstance(call, dict) and text(call.get("id")) and text(call.get("name")) and isinstance(call.get("arguments"), dict)
        elif kind == "tool.completed":
            valid = text(event.get("callId")) and "output" in event
        elif kind == "usage.reported":
            valid = count(event.get("step"), True) and valid_usage(event.get("usage"))
        elif kind == "run.completed":
            valid = valid_result(event.get("result"), self.request, self.run_id)
        else:
            valid = valid_error(event.get("error"))
        if not valid:
            raise DriverError("INVALID_STREAM", "The event contained an invalid payload or result identity.")
        return event


class SSEDecoder:
    """Incremental byte framing shared by sync and async transports."""
    def __init__(self):
        self.buffer, self.fields = bytearray(), []
        self.skip_lf, self.first_line, self.frame_bytes = False, True, 0

    def feed(self, chunk):
        self.buffer.extend(chunk)
        while True:
            if self.skip_lf and self.buffer:
                if self.buffer[0] == 10:
                    del self.buffer[:1]
                self.skip_lf = False
            positions = [n for n in [self.buffer.find(b"\r"), self.buffer.find(b"\n")] if n >= 0]
            if not positions:
                break
            end = min(positions)
            line = bytes(self.buffer[:end])
            self.skip_lf = self.buffer[end] == 13
            del self.buffer[:end + 1]
            if self.first_line:
                line = line.removeprefix(b"\xef\xbb\xbf")
                self.first_line = False
            self.frame_bytes += len(line)
            if self.frame_bytes > MAX_BYTES:
                raise DriverError("RESPONSE_TOO_LARGE", "An event exceeded 2 MB.")
            try:
                decoded = line.decode("utf-8")
            except UnicodeError:
                raise DriverError("INVALID_STREAM", "The event stream is not valid UTF-8.") from None
            if decoded.startswith("data:"):
                self.fields.append(decoded[5:].removeprefix(" "))
            elif not decoded:
                fields = self.fields
                self.fields, self.frame_bytes = [], 0
                if fields:
                    yield "\n".join(fields)
        if len(self.buffer) + self.frame_bytes > MAX_BYTES:
            raise DriverError("RESPONSE_TOO_LARGE", "An event exceeded 2 MB.")

    def finish(self):
        raise DriverError("INCOMPLETE_STREAM", "Connection closed before a terminal run event.")


def sse_data(response):
    """Recognize all SSE line endings without waiting for an extra byte after CR."""
    decoder = SSEDecoder()
    while True:
        chunk = response.read1(8192)
        yield from decoder.feed(chunk)
        if not chunk:
            decoder.finish()
