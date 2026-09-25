"""One-use host invitations. Store exchanged credentials only in the application's private backend."""
import base64
import re
from typing import Any, cast
from typing_extensions import NotRequired, TypedDict
from ._errors import DriverError
from ._transport import connection_url

class ConnectionGrant(TypedDict):
    subject: str
    providers: list[str]
    manageProviders: NotRequired[bool]
    tools: NotRequired[list[str]]
    approveTools: NotRequired[list[str]]
    applicationTools: NotRequired[list[dict[str, Any]]]
    jobs: NotRequired[list[str]]
    sessions: NotRequired[list[str]]
    retrieval: NotRequired[dict[str, list[str]]]

class CreateInvitation(TypedDict):
    grant: ConnectionGrant
    expiresInSeconds: NotRequired[int]
    connectionLifetimeSeconds: NotRequired[int]

class ConnectionInfo(TypedDict):
    id: str
    grant: ConnectionGrant
    createdAt: str
    expiresAt: str

class ConnectionInvitation(ConnectionInfo):
    code: str

class ConnectionCredentials(ConnectionInfo):
    token: str

class ConnectionList(TypedDict):
    invitations: list[ConnectionInfo]
    connections: list[ConnectionInfo]

def connection_target(invitation: str) -> tuple[str, str]:
    try:
        version, encoded, code = invitation.strip().split(".")
        if version != "ad1" or not re.fullmatch(r"[A-Za-z0-9_-]{1,8192}", encoded) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", code):
            raise ValueError()
        url = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("ascii")
        return connection_url(url, code), code
    except Exception:
        raise DriverError("INVALID_INVITATION", "Use a complete invitation from the selected AgenticDriver host.") from None

def connection_value(value: Any, kind: str) -> Any:
    from ._protocol import valid_timestamp
    def info(item: Any) -> bool:
        return (isinstance(item, dict) and isinstance(item.get("id"), str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", item["id"]) is not None
                and valid_timestamp(item.get("createdAt")) and valid_timestamp(item.get("expiresAt"))
                and isinstance(item.get("grant"), dict) and isinstance(item["grant"].get("subject"), str)
                and isinstance(item["grant"].get("providers"), list) and all(isinstance(p, str) for p in item["grant"]["providers"]))
    if kind == "list":
        valid = isinstance(value, dict) and all(isinstance(value.get(key), list) and len(value[key]) <= 1000 and all(info(i) and "token" not in i and "code" not in i for i in value[key]) for key in ["invitations", "connections"])
    elif kind == "revoke": valid = isinstance(value, dict) and isinstance(value.get("revoked"), bool)
    else: valid = info(value) and isinstance(value.get(kind), str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", value[kind]) is not None
    if not valid: raise DriverError("INVALID_RESPONSE", "The host returned invalid connection metadata. Reconcile before retrying.")
    return value
