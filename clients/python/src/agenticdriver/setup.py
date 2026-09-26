"""Caller-owned native sign-in. Provider tokens never pass through this contract."""
import re
from typing import Any, Literal, cast
from typing_extensions import NotRequired, TypedDict
from ._errors import DriverError
from ._protocol import valid_timestamp

class ProviderSetupConfig(TypedDict):
    kind: Literal["codex"]
    id: str
    accountId: str
    name: NotRequired[str]
    binary: NotRequired[str]
    enabled: NotRequired[bool]
    models: NotRequired[list[str]]
    reasoningEffort: NotRequired[str]
    applicationTools: NotRequired[Literal["mcp"]]

class ProviderSetupStart(TypedDict):
    action: Literal["start"]
    revision: str
    method: Literal["codex-device"]
    provider: ProviderSetupConfig

class ProviderSetupList(TypedDict):
    action: Literal["list"]

class ProviderSetupOperation(TypedDict):
    action: Literal["status", "accept", "cancel"]
    id: str

ProviderSetupRequest = ProviderSetupStart | ProviderSetupList | ProviderSetupOperation

class ProviderSetupInteraction(TypedDict):
    type: Literal["device-code"]
    verificationUrl: str
    userCode: str

class ProviderSetupAccount(TypedDict):
    email: str | None
    plan: str
    providerAccountId: NotRequired[str]

class ProviderSetupError(TypedDict):
    code: str
    message: str

class ProviderSetupAttempt(TypedDict):
    id: str
    providerId: str
    accountId: str
    name: str
    revision: str
    method: Literal["codex-device"]
    phase: Literal["starting", "waiting", "verifying", "ready", "succeeded", "failed", "cancelled", "expired"]
    createdAt: str
    updatedAt: str
    expiresAt: str
    interaction: NotRequired[ProviderSetupInteraction]
    account: NotRequired[ProviderSetupAccount]
    error: NotRequired[ProviderSetupError]

class ProviderSetupSnapshot(TypedDict):
    version: int
    attempts: list[ProviderSetupAttempt]

def _text(value: Any, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit

def _match(pattern: str, value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None

_uuid = r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}"
_instance = r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}"
_revision = r"[a-f0-9]{64}"

def setup_request(value: ProviderSetupRequest) -> ProviderSetupRequest:
    valid = False
    if isinstance(value, dict):
        action = value.get("action")
        if action == "list": valid = set(value) == {"action"}
        elif action in ("status", "accept", "cancel"):
            valid = set(value) == {"action", "id"} and _match(_uuid, value.get("id"))
        elif action == "start":
            p = value.get("provider")
            valid = (set(value) == {"action", "revision", "method", "provider"}
                and value.get("method") == "codex-device" and _match(_revision, value.get("revision"))
                and isinstance(p, dict) and p.get("kind") == "codex"
                and _match(_instance, p.get("id")) and _match(_instance, p.get("accountId"))
                and not set(p) - {"kind", "id", "accountId", "name", "binary", "enabled", "models", "reasoningEffort", "applicationTools"}
                and ("name" not in p or _text(p["name"], 100))
                and ("binary" not in p or _text(p["binary"], 4096))
                and ("enabled" not in p or isinstance(p["enabled"], bool))
                and ("models" not in p or (isinstance(p["models"], list) and len(p["models"]) <= 1000 and all(_match(r"[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}", m) for m in p["models"])))
                and ("reasoningEffort" not in p or _match(r"[a-z][a-z0-9_-]{0,63}", p["reasoningEffort"]))
                and ("applicationTools" not in p or p["applicationTools"] == "mcp"))
    if not valid: raise DriverError("INVALID_SETUP_REQUEST", "Choose a supported provider setup operation.")
    return value

def setup_snapshot(value: Any, request: ProviderSetupRequest) -> ProviderSetupSnapshot:
    def invalid():
        raise DriverError("INVALID_RESPONSE", "The host returned invalid or mismatched provider setup state.")
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("attempts"), list) or len(value["attempts"]) > 32: invalid()
    attempts = []
    ids: set[str] = set()
    for a in value["attempts"]:
        if (not isinstance(a, dict) or not _match(_uuid, a.get("id")) or a["id"] in ids
            or not all(_match(_instance, a.get(k)) for k in ("providerId", "accountId"))
            or not _text(a.get("name"), 100) or not _match(_revision, a.get("revision")) or a.get("method") != "codex-device"
            or a.get("phase") not in ("starting", "waiting", "verifying", "ready", "succeeded", "failed", "cancelled", "expired")
            or not all(valid_timestamp(a.get(k)) for k in ("createdAt", "updatedAt", "expiresAt"))): invalid()
        ids.add(a["id"])
        entry = {k: a[k] for k in ("id", "providerId", "accountId", "name", "revision", "method", "phase", "createdAt", "updatedAt", "expiresAt")}
        if "interaction" in a:
            i = a["interaction"]
            if not isinstance(i, dict) or i.get("type") != "device-code" or i.get("verificationUrl") != "https://auth.openai.com/codex/device" or not _match(r"[A-Z0-9-]{4,40}", i.get("userCode")): invalid()
            entry["interaction"] = {k: i[k] for k in ("type", "verificationUrl", "userCode")}
        if "account" in a:
            account = a["account"]
            if (not isinstance(account, dict) or "email" not in account or not (account["email"] is None or isinstance(account["email"], str) and len(account["email"]) <= 320)
                or not _text(account.get("plan"), 80) or ("providerAccountId" in account and not _text(account["providerAccountId"], 256))): invalid()
            entry["account"] = {k: account[k] for k in ("email", "plan", "providerAccountId") if k in account}
        if "error" in a:
            e = a["error"]
            if not isinstance(e, dict) or not _text(e.get("code"), 80) or not _text(e.get("message"), 512): invalid()
            entry["error"] = {k: e[k] for k in ("code", "message")}
        attempts.append(entry)
    if request["action"] != "list":
        if len(attempts) != 1: invalid()
        a = attempts[0]
        if request["action"] == "start":
            if a["providerId"] != request["provider"]["id"] or a["accountId"] != request["provider"]["accountId"] or a["revision"] != request["revision"] or a["method"] != request["method"]: invalid()
        elif a["id"] != request["id"]: invalid()
    return cast(ProviderSetupSnapshot, {"version": 1, "attempts": attempts})
