"""Provider management is a separate host grant, never implied by execution access."""
import re
from typing import Any, cast
from typing_extensions import NotRequired, TypedDict
from ._errors import DriverError

class ProviderConfiguration(TypedDict):
    id: str
    kind: str
    accountId: NotRequired[str]
    name: NotRequired[str]
    enabled: NotRequired[bool]
    models: NotRequired[list[str]]
    apiKeyRef: NotRequired[dict[str, Any]]
    baseUrl: NotRequired[str]
    binary: NotRequired[str]
    accountDirectory: NotRequired[str]
    reasoningEffort: NotRequired[str]
    inputMediaTypes: NotRequired[dict[str, list[str]]]
    extensionId: NotRequired[str]
    extensionVersion: NotRequired[str]
    settings: NotRequired[dict[str, Any]]
    secretRefs: NotRequired[dict[str, Any]]

class ManagementSnapshot(TypedDict):
    version: int
    revision: str
    providers: list[ProviderConfiguration]
    supportedKinds: list[str]

class ConfigureProvider(TypedDict):
    revision: str
    provider: ProviderConfiguration
    apiKey: NotRequired[str]

def snapshot(value: Any, provider_id: str | None = None) -> ManagementSnapshot:
    valid = (
        isinstance(value, dict) and value.get("version") == 1
        and isinstance(value.get("revision"), str)
        and re.fullmatch(r"[a-f0-9]{64}", value["revision"]) is not None
        and isinstance(value.get("providers"), list) and len(value["providers"]) <= 32
        and isinstance(value.get("supportedKinds"), list)
        and all(isinstance(k, str) and k for k in value["supportedKinds"])
    )
    if valid:
        ids = []
        for p in value["providers"]:
            if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not isinstance(p.get("kind"), str):
                valid = False
                break
            if "models" in p and (not isinstance(p["models"], list) or not all(isinstance(m, str) for m in p["models"])):
                valid = False
                break
            ids.append(p["id"])
        valid = valid and len(ids) == len(set(ids)) and (provider_id is None or provider_id in ids)
    if not valid:
        raise DriverError("INVALID_RESPONSE", "The host returned invalid or mismatched provider settings. Refresh before retrying.")
    return cast(ManagementSnapshot, value)
