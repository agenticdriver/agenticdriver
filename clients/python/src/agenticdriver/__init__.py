"""AgenticDriver v1 client. HTTPS remotely; authenticated HTTP on loopback."""

import json
import ssl
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

__all__ = ["AgenticClient", "DriverError", "PROTOCOL_VERSION"]

PROTOCOL_VERSION = "1.0"
_EVENT_TYPES = {"run.started", "step.started", "text.delta", "run.progress", "tool.called", "tool.completed", "usage.reported", "run.completed", "run.failed", "run.cancelled"}


class DriverError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.retryable = code, retryable


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
            if response.headers.get("AgenticDriver-Version") not in {None, PROTOCOL_VERSION}:
                response.close()
                raise DriverError("UNSUPPORTED_PROTOCOL_VERSION", "The host selected an unsupported wire protocol version.")
            return response
        except HTTPError as error:
            try:
                payload = json.loads(error.read(64_000)).get("error", {})
            except (ValueError, AttributeError):
                payload = {}
            finally:
                error.close()
            raise DriverError(payload.get("code", "HTTP_ERROR"), payload.get("message", f"Driver returned HTTP {error.code}."), payload.get("retryable", False)) from None

    @staticmethod
    def _json(response) -> Any:
        data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise DriverError("RESPONSE_TOO_LARGE", "The response exceeded 2 MB.")
        try:
            return json.loads(data)
        except ValueError:
            raise DriverError("INVALID_RESPONSE", "The driver returned malformed JSON.") from None

    def providers(self) -> list[dict[str, Any]]:
        with self._request("v1/providers") as response:
            return self._json(response)["providers"]

    def protocol(self) -> dict[str, Any]:
        with self._request("v1/protocol") as response:
            info = self._json(response)
            if (not isinstance(info, dict) or info.get("protocol") != "agenticdriver" or
                    info.get("version") != PROTOCOL_VERSION or
                    not isinstance(info.get("supportedVersions"), list) or PROTOCOL_VERSION not in info["supportedVersions"] or
                    not isinstance(info.get("features"), list)):
                raise DriverError("INVALID_RESPONSE", "The driver returned an invalid protocol descriptor.")
            return info

    def run(self, **request: Any) -> dict[str, Any]:
        with self._request("v1/runs", request) as response:
            return self._json(response)

    def stream(self, **request: Any) -> Iterator[dict[str, Any]]:
        """Close this generator (or use contextlib.closing) to cancel an unfinished run."""
        with self._request("v1/runs", request, stream=True) as response:
            if "text/event-stream" not in response.headers.get("Content-Type", ""):
                raise DriverError("INVALID_RESPONSE", "Expected an SSE response.")
            fields: list[str] = []
            frame_bytes, sequence, run_id = 0, 0, None
            while True:
                line = response.readline(2_000_001)
                if not line:
                    raise DriverError("INCOMPLETE_STREAM", "Connection closed before a terminal run event.")
                frame_bytes += len(line)
                if frame_bytes > 2_000_000:
                    raise DriverError("RESPONSE_TOO_LARGE", "An event exceeded 2 MB.")
                text = line.decode("utf-8").rstrip("\r\n")
                if text.startswith("data:"):
                    fields.append(text[5:].removeprefix(" "))
                elif not text:
                    if fields:
                        try:
                            event = json.loads("\n".join(fields))
                        except ValueError:
                            raise DriverError("INVALID_STREAM", "Malformed event JSON.") from None
                        if (not isinstance(event, dict) or not isinstance(event.get("type"), str) or not event["type"] or
                                not isinstance(event.get("runId"), str) or not event["runId"] or
                                not isinstance(event.get("timestamp"), str) or type(event.get("sequence")) is not int or event["sequence"] != sequence + 1 or
                                ("optional" in event and type(event["optional"]) is not bool) or
                                (run_id is not None and event.get("runId") != run_id)):
                            raise DriverError("INVALID_STREAM", "Invalid or out-of-order event.")
                        sequence, run_id = event["sequence"], event["runId"]
                        if event["type"] not in _EVENT_TYPES:
                            if event.get("optional") is not True:
                                raise DriverError("UNSUPPORTED_EVENT", "The host sent an unknown required event type.")
                            fields, frame_bytes = [], 0
                            continue
                        yield event
                        if event["type"] in {"run.completed", "run.failed", "run.cancelled"}:
                            return
                    fields, frame_bytes = [], 0
