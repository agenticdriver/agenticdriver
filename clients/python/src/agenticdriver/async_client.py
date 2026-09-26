"""Native asyncio transport. Install ``agenticdriver[async]`` for HTTPX."""

import asyncio
import json
import ssl
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from types import TracebackType
from typing import TYPE_CHECKING, Any, cast
from typing_extensions import Unpack

if TYPE_CHECKING:
    import httpx

from .connections import CreateInvitation, ConnectionInvitation, ConnectionCredentials, ConnectionList, connection_value
from .management import ConfigureProvider, ManagementSnapshot, snapshot as management_snapshot
from .setup import ProviderSetupRequest, ProviderSetupSnapshot, setup_request, setup_snapshot
from ._errors import DriverError
from ._protocol import (
    EventDecoder,
    SSEDecoder,
    parse_json,
    valid_catalog,
    valid_error,
    valid_protocol,
    valid_result,
    valid_resolution,
    valid_tool_receipt,
    valid_timestamp,
)
from ._sessions import valid_session_snapshot, valid_session_delete
from ._jobs import valid_job, valid_job_page
from .jobs import JobSubmit, JobIdentity, JobInfo, JobEventsRequest, JobEventPage
from .models import SessionCreate, SessionIdentity, SessionSnapshot, SessionDeleteResult
from ._retrieval import valid_retrieval, valid_index_result, valid_delete_result
from ._transport import (
    TERMINAL_EVENTS,
    check_version,
    connection_url,
    headers,
    validate_timeout,
)
from .models import ProviderInfo, ProtocolInfo, RunEvent, RunRequest, RunResult, ApprovalDecision, ApprovalResolution
from .retrieval import (
    RetrievalSearch,
    RetrievalResult,
    RetrievalIndexRequest,
    RetrievalIndexResult,
    RetrievalDelete,
    RetrievalDeleteResult,
)
from .ingestion import IngestRequest, IngestResult
from .models import ToolExecutionIdentity, ToolExecutionResult, ToolExecutionReceipt


class AsyncRunStream(AsyncIterator[RunEvent]):
    """Use ``async with`` or ``aclose()``; cancellation also closes the response."""

    def __init__(
        self,
        iterator: AsyncGenerator[RunEvent, None],
        release: Callable[["AsyncRunStream"], None],
    ):
        self._iterator = iterator
        self._release = release
        self._closed = False
        self._pending: asyncio.Future[RunEvent] | None = None

    def __aiter__(self) -> "AsyncRunStream":
        return self

    async def __anext__(self) -> RunEvent:
        if self._closed:
            raise StopAsyncIteration
        if self._pending is not None:
            raise RuntimeError("Read each stream from one task at a time.")
        pending = asyncio.ensure_future(self._iterator.__anext__())
        self._pending = pending
        try:
            event = await pending
        except BaseException:
            self._pending = None
            await self.aclose()
            raise
        finally:
            self._pending = None
        if event["type"] in TERMINAL_EVENTS:
            await self.aclose()
        return event

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._pending is not None and not self._pending.done():
                self._pending.cancel()
                try:
                    await self._pending
                except asyncio.CancelledError:
                    pass
            await self._iterator.aclose()
        finally:
            self._release(self)

    async def __aenter__(self) -> "AsyncRunStream":
        if self._closed:
            raise DriverError("STREAM_CLOSED", "This stream is closed.")
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()


class AsyncAgenticClient:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca_file: str | None = None,
        io_timeout: float | None = None,
        discovery_timeout: float | None = 10,
        transport: "httpx.AsyncBaseTransport | None" = None,
    ):
        self._url = connection_url(url, token)
        self._token = token
        self._io_timeout = validate_timeout(io_timeout)
        self._discovery_timeout = validate_timeout(discovery_timeout)
        try:
            import httpx
        except ImportError:
            raise ImportError(
                "Install 'agenticdriver[async]' to use AsyncAgenticClient."
            ) from None
        self._client = httpx.AsyncClient(
            verify=ssl.create_default_context(cafile=ca_file),
            timeout=None,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )
        self._streams: set[AsyncRunStream] = set()
        self._closed = False

    def _ensure_open(self) -> None:
        if self._closed:
            raise DriverError("CLIENT_CLOSED", "This client is closed.")

    async def __aenter__(self) -> "AsyncAgenticClient":
        self._ensure_open()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        self._closed = True
        try:
            for stream in tuple(self._streams):
                await stream.aclose()
        finally:
            await self._client.aclose()

    @asynccontextmanager
    async def _request(
        self, path: str, body: Mapping[str, object] | None = None, stream: bool = False
    ) -> AsyncIterator["httpx.Response"]:
        self._ensure_open()
        async with self._client.stream(
            "GET" if body is None else "POST",
            self._url + path,
            content=json.dumps(body).encode() if body is not None else None,
            headers=headers(self._token, stream, body is not None),
            timeout=self._io_timeout if body is not None else self._discovery_timeout,
        ) as response:
            if not response.is_success:
                try:
                    payload = parse_json(await self._bytes(response, 64_000)).get(
                        "error", {}
                    )
                except (DriverError, AttributeError):
                    payload = {}
                if valid_error(payload):
                    raise DriverError(
                        payload["code"],
                        payload["message"],
                        payload["retryable"],
                        payload.get("outcome"),
                    )
                raise DriverError(
                    "HTTP_ERROR",
                    f"Driver returned HTTP {response.status_code}.",
                    response.status_code == 429 or response.status_code >= 500,
                )
            check_version(response.headers.get_list("AgenticDriver-Version") or None)
            yield response

    @staticmethod
    async def _bytes(response: "httpx.Response", limit: int = 2_000_000) -> bytes:
        data = bytearray()
        async for chunk in response.aiter_bytes():
            if len(data) + len(chunk) > limit:
                raise DriverError(
                    "RESPONSE_TOO_LARGE", "The response exceeded its size limit."
                )
            data.extend(chunk)
        return bytes(data)

    async def _json(self, response: "httpx.Response") -> Any:
        return parse_json(await self._bytes(response))

    async def report_tool_progress(self, message: ToolExecutionIdentity) -> ToolExecutionReceipt:
        async with self._request("v1/tool-executions/progress", message) as response:
            result = await self._json(response)
            if not valid_tool_receipt(result, message, "progress"):
                raise DriverError("INVALID_RESPONSE", "The tool receipt does not match its submission; reconcile the originating run.")
            return cast(ToolExecutionReceipt, result)

    async def complete_tool(self, message: ToolExecutionResult) -> ToolExecutionReceipt:
        async with self._request("v1/tool-executions/results", message) as response:
            result = await self._json(response)
            if not valid_tool_receipt(result, message, "accepted"):
                raise DriverError("INVALID_RESPONSE", "The tool receipt does not match its submission; reconcile the originating run.")
            return cast(ToolExecutionReceipt, result)

    async def decide_approval(self, decision: ApprovalDecision) -> ApprovalResolution:
        async with self._request("v1/approvals/decisions", decision) as response:
            result = await self._json(response)
            if not valid_resolution(result, decision=decision):
                raise DriverError("INVALID_RESPONSE", "The approval receipt does not match the decision; reconcile using the run stream.")
            return cast(ApprovalResolution, result)

    async def ingest_context(self, request: IngestRequest) -> IngestResult:
        async with self._request("v1/retrieval/ingest", request) as response:
            result = await self._json(response)
            document = request["document"]
            source = document if document["type"] == "reference" else document["source"]
            if (
                not valid_index_result(
                    result, {"corpus": request["corpus"], "source": source}
                )
                or "ingestion" not in result
            ):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned invalid ingestion provenance or a mismatched receipt.",
                )
            return cast(IngestResult, result)

    async def search_context(self, request: RetrievalSearch) -> RetrievalResult:
        async with self._request("v1/retrieval/search", request) as response:
            result = await self._json(response)
            if not valid_retrieval(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned invalid or unscoped retrieval evidence.",
                )
            return cast(RetrievalResult, result)

    async def index_context(
        self, request: RetrievalIndexRequest
    ) -> RetrievalIndexResult:
        async with self._request("v1/retrieval/index", request) as response:
            result = await self._json(response)
            if not valid_index_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid indexing receipt.",
                )
            return cast(RetrievalIndexResult, result)

    async def delete_context(self, request: RetrievalDelete) -> RetrievalDeleteResult:
        async with self._request("v1/retrieval/delete", request) as response:
            result = await self._json(response)
            if not valid_delete_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid deletion receipt.",
                )
            return cast(RetrievalDeleteResult, result)

    async def submit_job(self, request: JobSubmit) -> JobInfo:
        return await self._job_request("submit", request)

    async def read_job(self, request: JobIdentity) -> JobInfo:
        return await self._job_request("read", request)

    async def cancel_job(self, request: JobIdentity) -> JobInfo:
        return await self._job_request("cancel", request)

    async def _job_request(self, operation: str, request: JobSubmit | JobIdentity) -> JobInfo:
        async with self._request(f"v1/jobs/{operation}", request) as response:
            result = await self._json(response)
            if not valid_job(result, request):
                raise DriverError("INVALID_RESPONSE", "Invalid or mismatched job metadata.")
            return cast(JobInfo, result)

    async def job_events(self, request: JobEventsRequest) -> JobEventPage:
        async with self._request("v1/jobs/events", request) as response:
            result = await self._json(response)
            if not valid_job_page(result, request):
                raise DriverError("INVALID_RESPONSE", "Invalid or out-of-order job event page.")
            return cast(JobEventPage, result)

    async def create_session(self, request: SessionCreate) -> SessionSnapshot:
        async with self._request("v1/sessions/create", request) as response:
            result = await self._json(response)
            if not valid_session_snapshot(result, request, "create", valid_timestamp):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionSnapshot, result)

    async def read_session(self, request: SessionIdentity) -> SessionSnapshot:
        async with self._request("v1/sessions/read", request) as response:
            result = await self._json(response)
            if not valid_session_snapshot(result, request, "read", valid_timestamp):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionSnapshot, result)

    async def delete_session(self, request: SessionIdentity) -> SessionDeleteResult:
        async with self._request("v1/sessions/delete", request) as response:
            result = await self._json(response)
            if not valid_session_delete(result, request):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionDeleteResult, result)

    async def create_invitation(self, request: CreateInvitation) -> ConnectionInvitation:
        async with self._request("v1/management/invitations", request) as response:
            return cast(ConnectionInvitation, connection_value(await self._json(response), "code"))

    async def exchange_connection(self) -> ConnectionCredentials:
        async with self._request("v1/connections/exchange", {}) as response:
            return cast(ConnectionCredentials, connection_value(await self._json(response), "token"))

    async def connections(self) -> ConnectionList:
        async with self._request("v1/management/connections") as response:
            return cast(ConnectionList, connection_value(await self._json(response), "list"))

    async def revoke_connection(self, connection_id: str) -> bool:
        async with self._request("v1/management/connections/revoke", {"id": connection_id}) as response:
            return bool(connection_value(await self._json(response), "revoke")["revoked"])

    async def provider_setup(self, request: ProviderSetupRequest) -> ProviderSetupSnapshot:
        async with self._request("v1/management/setup", setup_request(request)) as response:
            return setup_snapshot(await self._json(response), request)

    async def management(self) -> ManagementSnapshot:
        async with self._request("v1/management") as response:
            return management_snapshot(await self._json(response))

    async def configure_provider(self, request: ConfigureProvider) -> ManagementSnapshot:
        async with self._request("v1/management/providers", request) as response:
            return management_snapshot(await self._json(response), request["provider"]["id"], request.get("remove") is True)

    async def providers(self, *, refresh: bool = False) -> list[ProviderInfo]:
        async with self._request(
            "v1/providers?refresh=true" if refresh else "v1/providers"
        ) as response:
            catalog = await self._json(response)
            if not valid_catalog(catalog):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid provider catalog.",
                )
            return cast(list[ProviderInfo], catalog["providers"])

    async def protocol(self) -> ProtocolInfo:
        async with self._request("v1/protocol") as response:
            info = await self._json(response)
            if not valid_protocol(info):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid protocol descriptor.",
                )
            return cast(ProtocolInfo, info)

    async def run(self, **request: Unpack[RunRequest]) -> RunResult:
        if request.get("applicationTools"):
            raise DriverError("TOOL_STREAM_REQUIRED", "Use stream() to execute application-owned tools.")
        if request.get("approvals"):
            raise DriverError("APPROVAL_STREAM_REQUIRED", "Use stream() to receive and decide interactive approvals.")
        async with self._request("v1/runs", request) as response:
            result = await self._json(response)
            if not valid_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE", "The driver returned an invalid run result."
                )
            return cast(RunResult, result)

    def stream(self, **request: Unpack[RunRequest]) -> AsyncRunStream:
        self._ensure_open()
        stream = AsyncRunStream(self._events(request), self._streams.discard)
        self._streams.add(stream)
        return stream

    async def _events(self, request: RunRequest) -> AsyncGenerator[RunEvent, None]:
        async with self._request("v1/runs", request, stream=True) as response:
            if "text/event-stream" not in response.headers.get("Content-Type", ""):
                raise DriverError("INVALID_RESPONSE", "Expected an SSE response.")
            decoder, frames = EventDecoder(request), SSEDecoder()
            async for chunk in response.aiter_bytes():
                for data in frames.feed(chunk):
                    event = decoder.accept(parse_json(data, "INVALID_STREAM"))
                    if event is not None:
                        yield cast(RunEvent, event)
                        if event["type"] in TERMINAL_EVENTS:
                            return
            frames.finish()
