# AgenticDriver Python SDK

Python 3.10+ clients for an authenticated AgenticDriver host. Provider API keys
and subscription credentials stay on that host. Choose a provider instance and
model explicitly; clients never switch them or retry a request automatically.

Build and install from a reviewed checkout while registry publication is pending:

```sh
python -m pip install build
python -m build --wheel clients/python
python -m pip install clients/python/dist/agenticdriver-0.1.0-py3-none-any.whl
# Native asyncio support:
python -m pip install 'clients/python/dist/agenticdriver-0.1.0-py3-none-any.whl[async]'
```

The base installation uses the standard-library HTTP transport and
`typing_extensions`. The `async` extra adds HTTPX. Importing the package, using
types, or running the synchronous client does not require HTTPX.

## Synchronous execution

```python
from agenticdriver import AgenticClient, RunRequest

request: RunRequest = {
    "provider": "my-instance", "model": "explicit-model", "input": "Summarize this",
}
with AgenticClient("http://127.0.0.1:7433", token="YOUR_DRIVER_TOKEN") as client:
    print(client.providers(refresh=True))  # Read-only discovery, no generation.
    result = client.run(**request)
    print(result["text"])
    with client.stream(**request) as events:
        for event in events:
            if event["type"] == "text.delta":
                print(event["text"], end="", flush=True)
```

`RunStream` is an iterator and context manager. Completion, a protocol error,
`close()`, or leaving `with` closes the response. Breaking iteration alone does
not imply ownership cleanup: use `with` or call `close()` explicitly. Closing a
client closes its outstanding streams. Do not share a synchronous stream across
threads; use asyncio task cancellation to interrupt an active receive.

## Native asyncio execution

```python
import asyncio
from agenticdriver import AsyncAgenticClient, RunRequest

async def main() -> None:
    request: RunRequest = {
        "provider": "my-instance", "model": "explicit-model", "input": "Summarize this",
    }
    async with AsyncAgenticClient("https://driver.example", token="YOUR_DRIVER_TOKEN") as client:
        result = await client.run(**request)
        print(result["text"])
        async with client.stream(**request) as events:
            async for event in events:
                if event["type"] == "run.completed":
                    print(event["result"]["usage"])

asyncio.run(main())
```

There is no worker-thread wrapper. One asyncio task reads each stream; independent
streams can share a client on the same event loop. Cancelling the consuming task
propagates `asyncio.CancelledError` and closes its response. `await stream.aclose()`
or `await client.aclose()` also interrupts outstanding stream reads. Read streams
inside `async with`, including when stopping early or raising an application error.
Do not depend on garbage collection to cancel work.

Both styles expose `protocol`, `providers`, `run`, `stream`, `ingest_context`,
`index_context`, `search_context`, and `delete_context`; await the async methods
except `stream`, which returns an async iterator/context manager.

## Types, errors, and connection policy

`RunRequest`, `RunResult`, `Usage`, `ProviderInfo`, `ProtocolInfo`, and the tagged
`RunEvent` union are exported from `agenticdriver` and `agenticdriver.models`.
Context, retrieval, and ingestion models are also exported. They are `TypedDict`
wire objects, so existing dictionary code works. `run(**request)` and
`stream(**request)` check required and optional keyword fields with mypy; event
types narrow on `event["type"]`. Runtime response validation remains enabled.
`DriverError` exposes `code`, `retryable`, and optional `outcome == "uncertain"`.
An uncertain outcome needs reconciliation before repeating external effects.
Streaming failed/cancelled terminal events retain their typed error payload.

Remote endpoints require verified HTTPS. HTTP is permitted only on loopback.
Pass `ca_file="/path/to/private-ca.pem"` for a private CA; hostname verification
stays enabled. Redirects are not followed. The async client does not inherit
environment proxies, `.netrc`, or ambient credentials. An injected HTTPX
`transport` is caller-owned policy for tests or custom networking; it must verify
TLS appropriately when it performs real requests.

Execution has **no default total deadline or inactivity timeout**. A request's
`idleTimeoutMs` opts into host-side inactivity detection based on real model/tool/
context progress. Heartbeat comments do not reset it. Constructor `io_timeout`
defaults to `None` for run/retrieval/ingestion calls. An explicit positive value
sets socket/HTTP I/O timeouts, which cannot distinguish reasoning from a stalled
network and may interrupt a healthy quiet run. `discovery_timeout` defaults to
10 seconds for read-only discovery and can be changed or disabled. These are
separate from the host execution policy. An application can use its own asyncio
cancellation or `asyncio.wait_for` when it needs an explicit deadline.

The async transport disables [HTTPX's default network timeout](https://www.python-httpx.org/advanced/timeouts/)
for execution and uses its [response close lifecycle](https://www.python-httpx.org/async/).

## Verification

From the SDK repository, `npm run test:python` builds a wheel, installs it in a
fresh application environment, checks base and async dependencies and type
exports, then exercises both styles against local HTTP and certificate-verified
HTTPS hosts. It runs shared protocol fixtures, scoped RAG/ingestion, cancellation,
host inactivity, and TLS rejection checks. `npm run test:clients` includes these
same installed-wheel checks with TypeScript, Go and Rust conformance.

## Interactive approvals

Select `approvals={"mode": "interactive", "idlePolicy": "pause"}` in `stream()`. On an `approval.requested` event, review `event["approval"]["call"]` and submit `decide_approval({"approvalId": approval["approvalId"], "runId": approval["runId"], "call": approval["call"], "decision": "approve"})`; await this on `AsyncAgenticClient`. Decisions may also be `deny` or `cancel`. Typed policies, requests, decisions and resolutions are exported from `agenticdriver`.

The host must enable this feature and grant `approveTools`. `run` rejects
interactive mode because it cannot deliver review requests. There is no default
approval expiry; choose `expiresAfterMs` / the typed equivalent when needed.
Decisions are single-use and are never retried automatically. A receipt does not
confirm a tool effect. See the [approval contract](https://github.com/hashimkarim/agenticdriver/blob/sdk-roadmap/docs/approvals.md).
