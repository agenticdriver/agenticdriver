import asyncio
import io
import json
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import httpx

from agenticdriver import (
    AgenticClient,
    AsyncAgenticClient,
    DriverError,
    PROTOCOL_VERSION,
)

REQUEST = {"provider": "mock", "model": "demo", "input": "Hello"}
START = {
    "type": "run.started",
    "provider": "mock",
    "model": "demo",
    "runId": "r",
    "sequence": 1,
    "timestamp": "2026-09-21T00:00:00Z",
}


def frame(event):
    return ("data: " + json.dumps(event) + "\n\n").encode()


class Body(httpx.AsyncByteStream):
    def __init__(self, chunks, gate=None):
        self.chunks, self.gate, self.closed = chunks, gate, False
        self.waiting = asyncio.Event()

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        if self.gate is not None:
            self.waiting.set()
            await self.gate.wait()

    async def aclose(self):
        self.closed = True


class SyncLifecycle(unittest.TestCase):
    def test_context_exit_and_client_close_cancel_without_another_read(self):
        response = io.BytesIO(frame(START))
        response.headers = Message()
        response.headers["Content-Type"] = "text/event-stream"
        with AgenticClient("http://127.0.0.1:9999", "token") as client:
            client._opener = SimpleNamespace(open=lambda *args, **kwargs: response)
            with client.stream(**REQUEST) as stream:
                self.assertEqual(next(stream)["type"], "run.started")
            self.assertTrue(response.closed)
            untouched = client.stream(**REQUEST)
        self.assertEqual(list(untouched), [])
        with self.assertRaises(DriverError) as failure:
            client.stream(**REQUEST)
        self.assertEqual(failure.exception.code, "CLIENT_CLOSED")

    def test_io_timeouts_are_explicit_and_urls_are_sanitized(self):
        client = AgenticClient("https://driver.example", "token", io_timeout=0.25)
        calls = []

        def open_response(request, timeout):
            calls.append(timeout)
            raise OSError("fixture")

        client._opener = SimpleNamespace(open=open_response)
        with self.assertRaises(OSError):
            client.run(**REQUEST)
        with self.assertRaises(OSError):
            client.providers()
        self.assertEqual(calls, [0.25, 10])
        for url in [
            "http://remote.example",
            "https://user:secret@example.test",
            "https://[",
            "https://example.test:bad",
            "https://example.test\n",
        ]:
            with self.subTest(url=url), self.assertRaises(DriverError) as failure:
                AgenticClient(url, "token")
            self.assertEqual(failure.exception.code, "INSECURE_TRANSPORT")
            self.assertNotIn("secret", str(failure.exception))
        for value in [0, -1, float("nan"), float("inf"), True]:
            with self.assertRaises(ValueError):
                AgenticClient("https://driver.example", "token", io_timeout=value)


class AsyncLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_shared_version_fixtures_close_every_response(self):
        fixtures = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "protocol/fixtures/versioning.json"
            ).read_text(encoding="utf-8")
        )
        for case in fixtures["cases"]:
            with self.subTest(case=case["id"]):
                payload = (
                    b"".join(frame(event) for event in case["events"])
                    if "events" in case
                    else json.dumps(case["json"]).encode()
                )
                body = Body([payload[i : i + 3] for i in range(0, len(payload), 3)])

                def handle(request):
                    self.assertEqual(
                        request.headers["AgenticDriver-Version"], PROTOCOL_VERSION
                    )
                    self.assertEqual(
                        request.headers["AgenticDriver-Accept-Optional-Events"], "true"
                    )
                    self.assertTrue(
                        all(
                            value is None
                            for value in request.extensions["timeout"].values()
                        )
                    )
                    return httpx.Response(
                        case.get("status", 200),
                        headers={
                            "Content-Type": (
                                "text/event-stream"
                                if "events" in case
                                else "application/json"
                            ),
                            **case["headers"],
                        },
                        stream=body,
                    )

                async with AsyncAgenticClient(
                    "https://driver.example",
                    "token",
                    transport=httpx.MockTransport(handle),
                ) as client:
                    try:
                        async with client.stream(**REQUEST) as stream:
                            events = [event async for event in stream]
                        self.assertNotIn("expectedError", case)
                        self.assertEqual(
                            [event["type"] for event in events], case["expectedTypes"]
                        )
                    except DriverError as error:
                        self.assertEqual(error.code, case.get("expectedError"))
                    self.assertTrue(body.closed)

    async def test_break_exception_and_explicit_close_release_the_stream(self):
        for mode in ["break", "exception", "stream-close", "client-close"]:
            with self.subTest(mode=mode):
                body = Body([frame(START)], asyncio.Event())
                async with AsyncAgenticClient(
                    "https://driver.example",
                    "token",
                    transport=httpx.MockTransport(
                        lambda _: httpx.Response(
                            200,
                            headers={"Content-Type": "text/event-stream"},
                            stream=body,
                        )
                    ),
                ) as client:
                    try:
                        async with client.stream(**REQUEST) as stream:
                            self.assertEqual(
                                (await anext(stream))["type"], "run.started"
                            )
                            if mode == "exception":
                                raise ValueError("application failure")
                            if mode == "stream-close":
                                await stream.aclose()
                            if mode == "client-close":
                                await client.aclose()
                    except ValueError:
                        self.assertEqual(mode, "exception")
                    self.assertTrue(body.closed)
                    self.assertFalse(client._streams)

    async def test_task_cancellation_and_close_interrupt_a_pending_read(self):
        for mode in ["task", "stream", "client"]:
            with self.subTest(mode=mode):
                body = Body([frame(START)], asyncio.Event())
                async with AsyncAgenticClient(
                    "https://driver.example",
                    "token",
                    transport=httpx.MockTransport(
                        lambda _: httpx.Response(
                            200,
                            headers={"Content-Type": "text/event-stream"},
                            stream=body,
                        )
                    ),
                ) as client:
                    stream = client.stream(**REQUEST)
                    await anext(stream)
                    pending = asyncio.create_task(anext(stream))
                    await asyncio.wait_for(body.waiting.wait(), 1)
                    if mode == "task":
                        pending.cancel()
                    elif mode == "stream":
                        await stream.aclose()
                    else:
                        await client.aclose()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    self.assertTrue(body.closed)
                    self.assertFalse(client._streams)

    async def test_cancellation_before_headers_and_buffered_request_cleanup(self):
        waiting, release = asyncio.Event(), asyncio.Event()

        async def handle(_request):
            waiting.set()
            await release.wait()
            raise AssertionError("cancelled headers request continued")

        async with AsyncAgenticClient(
            "https://driver.example", "token", transport=httpx.MockTransport(handle)
        ) as client:
            pending = asyncio.create_task(client.run(**REQUEST))
            await asyncio.wait_for(waiting.wait(), 1)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        body = Body([b"{"], asyncio.Event())
        async with AsyncAgenticClient(
            "https://driver.example",
            "token",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=body)),
        ) as client:
            pending = asyncio.create_task(client.run(**REQUEST))
            await asyncio.wait_for(body.waiting.wait(), 1)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertTrue(body.closed)

    async def test_timeouts_redirects_and_size_limits_are_explicit(self):
        seen = []

        def handle(request):
            seen.append(request)
            return httpx.Response(
                302, headers={"Location": "https://other.example"}, json={}
            )

        async with AsyncAgenticClient(
            "https://driver.example",
            "token",
            io_timeout=0.25,
            transport=httpx.MockTransport(handle),
        ) as client:
            with self.assertRaises(DriverError) as failure:
                await client.run(**REQUEST)
            self.assertEqual(failure.exception.code, "HTTP_ERROR")
            self.assertEqual(len(seen), 1)
            self.assertTrue(
                all(value == 0.25 for value in seen[0].extensions["timeout"].values())
            )
        body = Body([b"x" * 2_000_001])
        async with AsyncAgenticClient(
            "https://driver.example",
            "token",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=body)),
        ) as client:
            with self.assertRaises(DriverError) as failure:
                await client.run(**REQUEST)
            self.assertEqual(failure.exception.code, "RESPONSE_TOO_LARGE")
            self.assertTrue(body.closed)
