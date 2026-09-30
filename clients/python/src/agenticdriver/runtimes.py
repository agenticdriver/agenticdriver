"""Explicit host-reviewed runtime installation, separate from sign-in and inference."""
import re
from typing import Any, Literal, cast
from typing_extensions import NotRequired, TypedDict
from ._errors import DriverError
from ._protocol import valid_timestamp

class ProviderRuntimeOperation(TypedDict):
    action: Literal["status", "install"]
    kind: Literal["codex"]

class ProviderRuntimeCancel(TypedDict):
    action: Literal["cancel"]
    kind: Literal["codex"]
    id: str

ProviderRuntimeRequest = ProviderRuntimeOperation | ProviderRuntimeCancel

class ProviderRuntimeError(TypedDict):
    code: str
    message: str

class ProviderRuntimeInfo(TypedDict):
    kind: Literal["codex"]
    version: Literal["0.157.0"]
    platform: Literal["linux-x64"]
    phase: Literal["missing", "downloading", "verifying", "installed", "failed", "cancelled"]
    archiveSha256: str
    downloadBytes: int
    totalBytes: int
    canCancel: bool
    id: NotRequired[str]
    updatedAt: NotRequired[str]
    binary: NotRequired[str]
    error: NotRequired[ProviderRuntimeError]

class ProviderRuntimeSnapshot(TypedDict):
    version: int
    runtimes: list[ProviderRuntimeInfo]

def _match(pattern: str, value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None

def _text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum

_uuid = r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}"

def runtime_request(value: ProviderRuntimeRequest) -> ProviderRuntimeRequest:
    if isinstance(value, dict) and value.get("kind") == "codex":
        if value.get("action") in ("status", "install") and set(value) == {"action", "kind"}: return value
        if value.get("action") == "cancel" and set(value) == {"action", "kind", "id"} and _match(_uuid, value.get("id")): return value
    raise DriverError("INVALID_RUNTIME_REQUEST", "Choose a supported runtime operation.")

def runtime_snapshot(value: Any, request: ProviderRuntimeRequest) -> ProviderRuntimeSnapshot:
    def invalid(): raise DriverError("INVALID_RESPONSE", "The host returned invalid or mismatched runtime state.")
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1 or not isinstance(value.get("runtimes"), list) or len(value["runtimes"]) != 1: invalid()
    r = value["runtimes"][0]
    if (not isinstance(r, dict) or r.get("kind") != request["kind"] or r.get("version") != "0.157.0" or r.get("platform") != "linux-x64"
        or r.get("phase") not in ("missing", "downloading", "verifying", "installed", "failed", "cancelled")
        or not _match(r"[a-f0-9]{64}", r.get("archiveSha256")) or type(r.get("canCancel")) is not bool
        or type(r.get("downloadBytes")) is not int or type(r.get("totalBytes")) is not int
        or not 0 <= r["downloadBytes"] <= r["totalBytes"] <= 9007199254740991 or r["totalBytes"] == 0): invalid()
    active = r["phase"] in ("downloading", "verifying")
    if (("id" in r and not _match(_uuid, r["id"])) or (active and "id" not in r)
        or (r["phase"] in ("installed", "verifying") and r["downloadBytes"] != r["totalBytes"]) or (r["canCancel"] and not active) or ("updatedAt" in r and not valid_timestamp(r["updatedAt"]))
        or (r["phase"] == "installed" and not _text(r.get("binary"), 4096)) or (r["phase"] != "installed" and "binary" in r)
        or (request["action"] == "cancel" and r.get("id") != request["id"])): invalid()
    if "error" in r:
        e = r["error"]
        if not isinstance(e, dict) or not _text(e.get("code"), 80) or not _text(e.get("message"), 512): invalid()
    keys = ("kind", "version", "platform", "phase", "archiveSha256", "downloadBytes", "totalBytes", "canCancel", "id", "updatedAt", "binary")
    result = {k: r[k] for k in keys if k in r}
    if "error" in r: result["error"] = {k: r["error"][k] for k in ("code", "message")}
    return cast(ProviderRuntimeSnapshot, {"version": 1, "runtimes": [result]})
