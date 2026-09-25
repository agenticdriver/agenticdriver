"""Shared provider component and backend bridge; mount behind the application's settings authorization."""
import base64
import html
import re
from importlib.resources import files
from typing import Any, Callable, Awaitable
from .client import AgenticClient
from .async_client import AsyncAgenticClient
from ._errors import DriverError

def provider_panel_script() -> bytes:
    return files("agenticdriver").joinpath("static/provider-panel.js").read_bytes()

def provider_panel_html(api_path: str = "/api/agenticdriver-panel", module_path: str = "/assets/agenticdriver-panel.js") -> str:
    for path in [api_path, module_path]:
        if not re.fullmatch(r"/(?!/)[^\s?#\\]*", path) or ".." in path.split("/"):
            raise ValueError("Use same-origin absolute asset and API paths.")
    return f'<agenticdriver-providers api="{html.escape(api_path, quote=True)}"></agenticdriver-providers><script type="module" src="{html.escape(module_path, quote=True)}"></script>'

class ProviderPanel:
    """Resolve an already connected SDK client; optional hooks own private connection persistence."""
    def __init__(self, client: Callable[[], AgenticClient | None], *, connection: Callable[[], dict[str, str] | None] | None = None, connect: Callable[[str], None] | None = None, disconnect: Callable[[], None] | None = None):
        self.client = client
        self.connection = connection or (lambda: None)
        self.connect = connect
        self.disconnect = disconnect

    def snapshot(self, refresh: bool = False) -> dict[str, Any]:
        client = self.client()
        state: dict[str, Any] = {"connected": client is not None, "providers": [], "canConnect": self.connect is not None, "canDisconnect": self.disconnect is not None, "canInvite": False}
        if self.connection(): state["connection"] = self.connection()
        if client is None: return state
        state["providers"] = client.providers(refresh=refresh)
        features = client.protocol()["features"]
        if "provider-management" in features:
            state["management"] = client.management()
            state["canInvite"] = bool(state.get("connection", {}).get("url") and "client-pairing" in features)
        return state

    def handle(self, request: dict[str, Any]) -> Any:
        action = request.get("action")
        if action == "snapshot": return self.snapshot(request.get("refresh") is True)
        if action == "connect" and self.connect:
            invitation = request.get("invitation")
            if not isinstance(invitation, str) or len(invitation) > 16384: raise DriverError("INVALID_INVITATION", "Use a complete host invitation.")
            self.connect(invitation)
            return self.snapshot()
        if action == "disconnect" and self.disconnect:
            self.disconnect()
            return self.snapshot()
        client = self.client()
        if client is None: raise DriverError("CONNECTION_REQUIRED", "Connect an AgenticDriver host first.")
        if action == "configure":
            client.configure_provider(request["change"])
            return self.snapshot()
        if action == "connections": return client.connections()
        if action == "revoke": return {"revoked": client.revoke_connection(request["id"])}
        if action == "invite":
            url = (self.connection() or {}).get("url")
            if not url: raise DriverError("CONNECTION_UNAVAILABLE", "Configure the host's public connection URL.")
            invite = client.create_invitation({"grant": {"subject": request["subject"], "providers": request["providers"], "manageProviders": request.get("manageProviders") is True}})
            encoded = base64.urlsafe_b64encode(url.encode("ascii")).decode().rstrip("=")
            return {"invitation": f'ad1.{encoded}.{invite["code"]}', "expiresAt": invite["expiresAt"], "grant": invite["grant"]}
        raise DriverError("INVALID_PANEL_REQUEST", "Choose a supported provider panel operation.")

class AsyncProviderPanel:
    """Same component bridge with async SDK client and async connection hooks."""
    def __init__(self, client: Callable[[], AsyncAgenticClient | None], *, connection: Callable[[], dict[str, str] | None] | None = None, connect: Callable[[str], Awaitable[None]] | None = None, disconnect: Callable[[], Awaitable[None]] | None = None):
        self.client = client
        self.connection = connection or (lambda: None)
        self.connect = connect
        self.disconnect = disconnect

    async def snapshot(self, refresh: bool = False) -> dict[str, Any]:
        client = self.client()
        state: dict[str, Any] = {"connected": client is not None, "providers": [], "canConnect": self.connect is not None, "canDisconnect": self.disconnect is not None, "canInvite": False}
        if self.connection(): state["connection"] = self.connection()
        if client is None: return state
        state["providers"] = await client.providers(refresh=refresh)
        features = (await client.protocol())["features"]
        if "provider-management" in features:
            state["management"] = await client.management()
            state["canInvite"] = bool(state.get("connection", {}).get("url") and "client-pairing" in features)
        return state

    async def handle(self, request: dict[str, Any]) -> Any:
        action = request.get("action")
        if action == "snapshot": return await self.snapshot(request.get("refresh") is True)
        if action == "connect" and self.connect:
            invitation = request.get("invitation")
            if not isinstance(invitation, str) or len(invitation) > 16384: raise DriverError("INVALID_INVITATION", "Use a complete host invitation.")
            await self.connect(invitation)
            return await self.snapshot()
        if action == "disconnect" and self.disconnect:
            await self.disconnect()
            return await self.snapshot()
        client = self.client()
        if client is None: raise DriverError("CONNECTION_REQUIRED", "Connect an AgenticDriver host first.")
        if action == "configure":
            await client.configure_provider(request["change"])
            return await self.snapshot()
        if action == "connections": return await client.connections()
        if action == "revoke": return {"revoked": await client.revoke_connection(request["id"])}
        if action == "invite":
            url = (self.connection() or {}).get("url")
            if not url: raise DriverError("CONNECTION_UNAVAILABLE", "Configure the host's public connection URL.")
            invite = await client.create_invitation({"grant": {"subject": request["subject"], "providers": request["providers"], "manageProviders": request.get("manageProviders") is True}})
            encoded = base64.urlsafe_b64encode(url.encode("ascii")).decode().rstrip("=")
            return {"invitation": f'ad1.{encoded}.{invite["code"]}', "expiresAt": invite["expiresAt"], "grant": invite["grant"]}
        raise DriverError("INVALID_PANEL_REQUEST", "Choose a supported provider panel operation.")
