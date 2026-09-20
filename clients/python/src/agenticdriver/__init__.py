"""AgenticDriver v1 client. HTTPS remotely; authenticated HTTP on loopback."""

import json
import ssl
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from ._errors import DriverError
from ._protocol import PROTOCOL_VERSION, EventDecoder, parse_json, sse_data, valid_catalog, valid_error, valid_protocol, valid_result

__all__ = ["AgenticClient", "DriverError", "PROTOCOL_VERSION"]

class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AgenticClient:
    def __init__(self, url: str, token: str, *, ca_file: str | None = None):
        parsed = urlsplit(url)
        if (parsed.username or parsed.password or parsed.query or parsed.fragment or
                not parsed.hostname or not (
                    parsed.scheme == "https" or
                    (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
            raise DriverError("INSECURE_TRANSPORT", "Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment.")
        if not token:
            raise DriverError("AUTH_REQUIRED", "A driver bearer token is required.")
        self._url = urlunsplit(parsed).rstrip("/") + "/"
        self._token = token
        self._opener = build_opener(_NoRedirects(), HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))

    def _request(self, path: str, body: dict | None = None, stream: bool = False):
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "text/event-stream" if stream else "application/json", "AgenticDriver-Version": PROTOCOL_VERSION, "AgenticDriver-Accept-Optional-Events": "true"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self._url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            # The execution host enforces optional idleTimeoutMs using real progress.
            # A buffered run may legitimately take hours; never impose a total run deadline.
            response = self._opener.open(request, timeout=None if body is not None else 10)
            versions = response.headers.get_all("AgenticDriver-Version")
            if versions is not None and versions != [PROTOCOL_VERSION]:
                response.close()
                raise DriverError("UNSUPPORTED_PROTOCOL_VERSION", "The host selected an unsupported wire protocol version.")
            return response
        except HTTPError as error:
            try:
                payload = parse_json(error.read(64_000)).get("error", {})
            except (DriverError, AttributeError):
                payload = {}
            finally:
                error.close()
            if valid_error(payload):
                raise DriverError(payload["code"], payload["message"], payload["retryable"]) from None
            raise DriverError("HTTP_ERROR", f"Driver returned HTTP {error.code}.", error.code == 429 or error.code >= 500) from None

    @staticmethod
    def _json(response) -> Any:
        data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise DriverError("RESPONSE_TOO_LARGE", "The response exceeded 2 MB.")
        return parse_json(data)

    def providers(self) -> list[dict[str, Any]]:
        with self._request("v1/providers") as response:
            catalog = self._json(response)
            if not valid_catalog(catalog):
                raise DriverError("INVALID_RESPONSE", "The driver returned an invalid provider catalog.")
            return catalog["providers"]

    def protocol(self) -> dict[str, Any]:
        with self._request("v1/protocol") as response:
            info = self._json(response)
            if not valid_protocol(info):
                raise DriverError("INVALID_RESPONSE", "The driver returned an invalid protocol descriptor.")
            return info

    def run(self, **request: Any) -> dict[str, Any]:
        with self._request("v1/runs", request) as response:
            result = self._json(response)
            if not valid_result(result, request):
                raise DriverError("INVALID_RESPONSE", "The driver returned an invalid run result.")
            return result

    def stream(self, **request: Any) -> Iterator[dict[str, Any]]:
        """Close this generator (or use contextlib.closing) to cancel an unfinished run."""
        with self._request("v1/runs", request, stream=True) as response:
            if "text/event-stream" not in response.headers.get("Content-Type", ""):
                raise DriverError("INVALID_RESPONSE", "Expected an SSE response.")
            decoder = EventDecoder(request)
            for data in sse_data(response):
                event = decoder.accept(parse_json(data, "INVALID_STREAM"))
                if event is None:
                    continue
                yield event
                if event["type"] in {"run.completed", "run.failed", "run.cancelled"}:
                    return
