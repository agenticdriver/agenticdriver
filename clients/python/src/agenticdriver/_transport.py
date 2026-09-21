"""Shared connection policy; execution inactivity is measured on the host."""

import math
from urllib.parse import urlsplit, urlunsplit

from ._errors import DriverError
from ._protocol import PROTOCOL_VERSION

TERMINAL_EVENTS = {"run.completed", "run.failed", "run.cancelled"}


def connection_url(url: str, token: str) -> str:
    try:
        if any(ord(c) <= 32 or ord(c) == 127 for c in url):
            raise ValueError()
        parsed = urlsplit(url)
        if (
            parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not parsed.hostname
            or parsed.port == 0
            or not (
                parsed.scheme == "https"
                or (
                    parsed.scheme == "http"
                    and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                )
            )
        ):
            raise ValueError()
    except (ValueError, TypeError):
        raise DriverError(
            "INSECURE_TRANSPORT",
            "Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment.",
        ) from None
    if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise DriverError(
            "AUTH_REQUIRED",
            "A driver bearer token is required, without whitespace or control characters.",
        )
    return urlunsplit(parsed).rstrip("/") + "/"


def validate_timeout(value: float | None) -> float | None:
    if value is not None and (
        isinstance(value, bool) or not math.isfinite(value) or value <= 0
    ):
        raise ValueError(
            "An I/O timeout must be a finite positive number of seconds, or None."
        )
    return value


def headers(token: str, stream: bool, body: bool) -> dict[str, str]:
    result = {
        "Authorization": f"Bearer {token}",
        "Accept": "text/event-stream" if stream else "application/json",
        "AgenticDriver-Version": PROTOCOL_VERSION,
        "AgenticDriver-Accept-Optional-Events": "true",
    }
    if body:
        result["Content-Type"] = "application/json"
    return result


def check_version(versions: list[str] | None) -> None:
    if versions is not None and versions != [PROTOCOL_VERSION]:
        raise DriverError(
            "UNSUPPORTED_PROTOCOL_VERSION",
            "The host selected an unsupported wire protocol version.",
        )
