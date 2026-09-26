"""Synchronous standard-library transport with explicit stream ownership."""

import json
import ssl
from collections.abc import Callable, Generator, Iterator, Mapping
from types import TracebackType
from typing import Any, cast
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from typing_extensions import Unpack

from .connections import CreateInvitation, ConnectionInvitation, ConnectionCredentials, ConnectionList, connection_value
from .management import ConfigureProvider, ManagementSnapshot, snapshot as management_snapshot
from .setup import ProviderSetupRequest, ProviderSetupSnapshot, setup_request, setup_snapshot
from ._errors import DriverError
from ._protocol import (
    EventDecoder,
    parse_json,
    sse_data,
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


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


class RunStream(Iterator[RunEvent]):
    """A lazy stream. Use ``with`` or ``close()`` when stopping before completion."""

    def __init__(
        self,
        iterator: Generator[RunEvent, None, None],
        release: Callable[["RunStream"], None],
    ):
        self._iterator = iterator
        self._release = release
        self._closed = False

    def __iter__(self) -> "RunStream":
        return self

    def __next__(self) -> RunEvent:
        if self._closed:
            raise StopIteration
        try:
            event = next(self._iterator)
            if event["type"] in TERMINAL_EVENTS:
                self.close()
            return event
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._iterator.close()
            finally:
                self._release(self)

    def __enter__(self) -> "RunStream":
        if self._closed:
            raise DriverError("STREAM_CLOSED", "This stream is closed.")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class AgenticClient:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca_file: str | None = None,
        io_timeout: float | None = None,
        discovery_timeout: float | None = 10,
    ):
        self._url = connection_url(url, token)
        self._token = token
        self._io_timeout = validate_timeout(io_timeout)
        self._discovery_timeout = validate_timeout(discovery_timeout)
        self._opener = build_opener(
            _NoRedirects(),
            HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)),
        )
        self._streams: set[RunStream] = set()
        self._closed = False

    def __enter__(self) -> "AgenticClient":
        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def _ensure_open(self) -> None:
        if self._closed:
            raise DriverError("CLIENT_CLOSED", "This client is closed.")

    def close(self) -> None:
        self._closed = True
        for stream in tuple(self._streams):
            stream.close()

    def _request(
        self, path: str, body: Mapping[str, object] | None = None, stream: bool = False
    ) -> Any:
        self._ensure_open()
        request = Request(
            self._url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers(self._token, stream, body is not None),
        )
        try:
            # Network I/O timeouts are opt-in for execution, distinct from the
            # host's progress-based idleTimeoutMs. No implicit total deadline.
            response = self._opener.open(
                request,
                timeout=(
                    self._io_timeout if body is not None else self._discovery_timeout
                ),
            )
            try:
                check_version(response.headers.get_all("AgenticDriver-Version"))
            except BaseException:
                response.close()
                raise
            return response
        except HTTPError as error:
            try:
                payload = parse_json(error.read(64_000)).get("error", {})
            except (DriverError, AttributeError):
                payload = {}
            finally:
                error.close()
            if valid_error(payload):
                raise DriverError(
                    payload["code"],
                    payload["message"],
                    payload["retryable"],
                    payload.get("outcome"),
                ) from None
            raise DriverError(
                "HTTP_ERROR",
                f"Driver returned HTTP {error.code}.",
                error.code == 429 or error.code >= 500,
            ) from None

    @staticmethod
    def _json(response: Any) -> Any:
        data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise DriverError("RESPONSE_TOO_LARGE", "The response exceeded 2 MB.")
        return parse_json(data)

    def report_tool_progress(self, message: ToolExecutionIdentity) -> ToolExecutionReceipt:
        with self._request("v1/tool-executions/progress", message) as response:
            result = self._json(response)
            if not valid_tool_receipt(result, message, "progress"):
                raise DriverError("INVALID_RESPONSE", "The tool receipt does not match its submission; reconcile the originating run.")
            return cast(ToolExecutionReceipt, result)

    def complete_tool(self, message: ToolExecutionResult) -> ToolExecutionReceipt:
        with self._request("v1/tool-executions/results", message) as response:
            result = self._json(response)
            if not valid_tool_receipt(result, message, "accepted"):
                raise DriverError("INVALID_RESPONSE", "The tool receipt does not match its submission; reconcile the originating run.")
            return cast(ToolExecutionReceipt, result)

    def decide_approval(self, decision: ApprovalDecision) -> ApprovalResolution:
        with self._request("v1/approvals/decisions", decision) as response:
            result = self._json(response)
            if not valid_resolution(result, decision=decision):
                raise DriverError("INVALID_RESPONSE", "The approval receipt does not match the decision; reconcile using the run stream.")
            return cast(ApprovalResolution, result)

    def ingest_context(self, request: IngestRequest) -> IngestResult:
        with self._request("v1/retrieval/ingest", request) as response:
            result = self._json(response)
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

    def search_context(self, request: RetrievalSearch) -> RetrievalResult:
        with self._request("v1/retrieval/search", request) as response:
            result = self._json(response)
            if not valid_retrieval(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned invalid or unscoped retrieval evidence.",
                )
            return cast(RetrievalResult, result)

    def index_context(self, request: RetrievalIndexRequest) -> RetrievalIndexResult:
        with self._request("v1/retrieval/index", request) as response:
            result = self._json(response)
            if not valid_index_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid indexing receipt.",
                )
            return cast(RetrievalIndexResult, result)

    def delete_context(self, request: RetrievalDelete) -> RetrievalDeleteResult:
        with self._request("v1/retrieval/delete", request) as response:
            result = self._json(response)
            if not valid_delete_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid deletion receipt.",
                )
            return cast(RetrievalDeleteResult, result)

    def submit_job(self, request: JobSubmit) -> JobInfo:
        return self._job_request("submit", request)

    def read_job(self, request: JobIdentity) -> JobInfo:
        return self._job_request("read", request)

    def cancel_job(self, request: JobIdentity) -> JobInfo:
        return self._job_request("cancel", request)

    def _job_request(self, operation: str, request: JobSubmit | JobIdentity) -> JobInfo:
        with self._request(f"v1/jobs/{operation}", request) as response:
            result = self._json(response)
            if not valid_job(result, request):
                raise DriverError("INVALID_RESPONSE", "Invalid or mismatched job metadata.")
            return cast(JobInfo, result)

    def job_events(self, request: JobEventsRequest) -> JobEventPage:
        with self._request("v1/jobs/events", request) as response:
            result = self._json(response)
            if not valid_job_page(result, request):
                raise DriverError("INVALID_RESPONSE", "Invalid or out-of-order job event page.")
            return cast(JobEventPage, result)

    def create_session(self, request: SessionCreate) -> SessionSnapshot:
        with self._request("v1/sessions/create", request) as response:
            result = self._json(response)
            if not valid_session_snapshot(result, request, "create", valid_timestamp):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionSnapshot, result)

    def read_session(self, request: SessionIdentity) -> SessionSnapshot:
        with self._request("v1/sessions/read", request) as response:
            result = self._json(response)
            if not valid_session_snapshot(result, request, "read", valid_timestamp):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionSnapshot, result)

    def delete_session(self, request: SessionIdentity) -> SessionDeleteResult:
        with self._request("v1/sessions/delete", request) as response:
            result = self._json(response)
            if not valid_session_delete(result, request):
                raise DriverError("INVALID_RESPONSE", "The conversation response does not match its request.")
            return cast(SessionDeleteResult, result)

    def create_invitation(self, request: CreateInvitation) -> ConnectionInvitation:
        with self._request("v1/management/invitations", request) as response:
            return cast(ConnectionInvitation, connection_value(self._json(response), "code"))

    def exchange_connection(self) -> ConnectionCredentials:
        with self._request("v1/connections/exchange", {}) as response:
            return cast(ConnectionCredentials, connection_value(self._json(response), "token"))

    def connections(self) -> ConnectionList:
        with self._request("v1/management/connections") as response:
            return cast(ConnectionList, connection_value(self._json(response), "list"))

    def revoke_connection(self, connection_id: str) -> bool:
        with self._request("v1/management/connections/revoke", {"id": connection_id}) as response:
            return bool(connection_value(self._json(response), "revoke")["revoked"])

    def provider_setup(self, request: ProviderSetupRequest) -> ProviderSetupSnapshot:
        with self._request("v1/management/setup", setup_request(request)) as response:
            return setup_snapshot(self._json(response), request)

    def management(self) -> ManagementSnapshot:
        with self._request("v1/management") as response:
            return management_snapshot(self._json(response))

    def configure_provider(self, request: ConfigureProvider) -> ManagementSnapshot:
        with self._request("v1/management/providers", request) as response:
            return management_snapshot(self._json(response), request["provider"]["id"])

    def providers(self, *, refresh: bool = False) -> list[ProviderInfo]:
        with self._request(
            "v1/providers?refresh=true" if refresh else "v1/providers"
        ) as response:
            catalog = self._json(response)
            if not valid_catalog(catalog):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid provider catalog.",
                )
            return cast(list[ProviderInfo], catalog["providers"])

    def protocol(self) -> ProtocolInfo:
        with self._request("v1/protocol") as response:
            info = self._json(response)
            if not valid_protocol(info):
                raise DriverError(
                    "INVALID_RESPONSE",
                    "The driver returned an invalid protocol descriptor.",
                )
            return cast(ProtocolInfo, info)

    def run(self, **request: Unpack[RunRequest]) -> RunResult:
        if request.get("applicationTools"):
            raise DriverError("TOOL_STREAM_REQUIRED", "Use stream() to execute application-owned tools.")
        if request.get("approvals"):
            raise DriverError("APPROVAL_STREAM_REQUIRED", "Use stream() to receive and decide interactive approvals.")
        with self._request("v1/runs", request) as response:
            result = self._json(response)
            if not valid_result(result, request):
                raise DriverError(
                    "INVALID_RESPONSE", "The driver returned an invalid run result."
                )
            return cast(RunResult, result)

    def stream(self, **request: Unpack[RunRequest]) -> RunStream:
        self._ensure_open()
        stream = RunStream(self._events(request), self._streams.discard)
        self._streams.add(stream)
        return stream

    def _events(self, request: RunRequest) -> Generator[RunEvent, None, None]:
        with self._request("v1/runs", request, stream=True) as response:
            if "text/event-stream" not in response.headers.get("Content-Type", ""):
                raise DriverError("INVALID_RESPONSE", "Expected an SSE response.")
            decoder = EventDecoder(request)
            for data in sse_data(response):
                event = decoder.accept(parse_json(data, "INVALID_STREAM"))
                if event is not None:
                    yield cast(RunEvent, event)
                    if event["type"] in TERMINAL_EVENTS:
                        return
