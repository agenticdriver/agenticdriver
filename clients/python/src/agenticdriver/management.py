"""Provider management is a separate host grant, never implied by execution access."""
import re
from typing import Any, Literal, cast
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
    applicationTools: NotRequired[Literal["mcp"]]
    inputMediaTypes: NotRequired[dict[str, list[str]]]
    extensionId: NotRequired[str]
    extensionVersion: NotRequired[str]
    settings: NotRequired[dict[str, Any]]
    secretRefs: NotRequired[dict[str, Any]]

class ProviderConnectionMethod(TypedDict):
    id: str
    label: str
    description: str
    interaction: str  # Unknown future interactions must remain unavailable for actions.
    credentialOwner: Literal["native-runtime", "host", "none"]

class ProviderDefinition(TypedDict):
    kind: str
    name: str
    description: str
    category: Literal["native", "api", "compatible", "fixture"]
    protocol: str
    methods: list[ProviderConnectionMethod]
    requirements: NotRequired[str]
    docsUrl: NotRequired[str]

class ManagementSnapshot(TypedDict):
    version: int
    revision: str
    providers: list[ProviderConfiguration]
    supportedKinds: list[str]
    providerDefinitions: NotRequired[list[ProviderDefinition]]
    executionProviders: NotRequired[list[str]]
    removalSupported: NotRequired[bool]

class ConfigureProvider(TypedDict):
    revision: str
    provider: ProviderConfiguration
    apiKey: NotRequired[str]
    remove: NotRequired[bool]

def _definition(value: Any) -> bool:
    def text(obj: dict, key: str, limit: int) -> bool:
        return isinstance(obj.get(key), str) and 0 < len(obj[key]) <= limit
    if not isinstance(value, dict) or not all(text(value, key, limit) for key, limit in [("kind", 80), ("name", 100), ("description", 1000), ("protocol", 100)]):
        return False
    if value.get("category") not in ("native", "api", "compatible", "fixture") or not isinstance(value.get("methods"), list) or not 1 <= len(value["methods"]) <= 8:
        return False
    if "requirements" in value and not text(value, "requirements", 2000):
        return False
    if "docsUrl" in value and (not text(value, "docsUrl", 2000) or not value["docsUrl"].startswith("https://")):
        return False
    return all(isinstance(m, dict) and text(m, "id", 80) and re.fullmatch(r"[a-z][a-z0-9-]{0,79}", m["id"]) is not None
               and text(m, "label", 100) and text(m, "description", 1000)
               and text(m, "interaction", 80) and re.fullmatch(r"[a-z][a-z0-9-]{0,79}", m["interaction"]) is not None
               and m.get("credentialOwner") in ("native-runtime", "host", "none") for m in value["methods"])

def snapshot(value: Any, provider_id: str | None = None, removed: bool = False) -> ManagementSnapshot:
    valid = (
        isinstance(value, dict) and value.get("version") == 1
        and ("removalSupported" not in value or isinstance(value["removalSupported"], bool))
        and isinstance(value.get("revision"), str)
        and re.fullmatch(r"[a-f0-9]{64}", value["revision"]) is not None
        and isinstance(value.get("providers"), list) and len(value["providers"]) <= 32
        and isinstance(value.get("supportedKinds"), list)
        and all(isinstance(k, str) and k for k in value["supportedKinds"])
        and ("executionProviders" not in value or (isinstance(value["executionProviders"], list) and all(isinstance(p, str) and p for p in value["executionProviders"])))
        and ("providerDefinitions" not in value or (isinstance(value["providerDefinitions"], list) and len(value["providerDefinitions"]) <= 32 and all(_definition(d) for d in value["providerDefinitions"])))
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
        valid = valid and len(ids) == len(set(ids)) and (provider_id is None or ((provider_id in ids) != removed))
    if not valid:
        raise DriverError("INVALID_RESPONSE", "The host returned invalid or mismatched provider settings. Refresh before retrying.")
    return cast(ManagementSnapshot, value)
