import asyncio
import json
import os
import unittest
from pathlib import Path

from agenticdriver import AsyncAgenticClient, DriverError


@unittest.skipUnless(
    os.environ.get("AGENTICDRIVER_TEST_REFERENCE_URL"), "requires the reference host"
)
class AsyncConformance(unittest.IsolatedAsyncioTestCase):
    def client(self, url=None, token=None, ca=True):
        return AsyncAgenticClient(
            url or os.environ["AGENTICDRIVER_TEST_URL"],
            token or os.environ["AGENTICDRIVER_TEST_TOKEN"],
            ca_file=os.environ.get("AGENTICDRIVER_TEST_CA") if ca else None,
        )

    async def test_wire_cases(self):
        fixture = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "protocol/fixtures/conformance.json"
            ).read_text()
        )
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                failure = None
                async with self.client(
                    os.environ["AGENTICDRIVER_TEST_REFERENCE_URL"]
                    + "/fixtures/"
                    + case["id"]
                ) as client:
                    try:
                        if case.get("operation") == "providers":
                            await client.providers()
                        elif case.get("operation") == "protocol":
                            await client.protocol()
                        elif case.get("operation") == "ingest":
                            await client.ingest_context(
                                {
                                    "corpus": "library",
                                    "document": {
                                        "type": "reference",
                                        "id": "paper",
                                        "revision": "r1",
                                        "mediaType": "text/markdown",
                                    },
                                }
                            )
                        else:
                            async with client.stream(
                                provider="mock",
                                model="demo",
                                input="Hello",
                                **(
                                    {"retrieval": case["retrieval"]}
                                    if "retrieval" in case
                                    else {}
                                )
                            ) as stream:
                                completed = cancelled = False
                                async for event in stream:
                                    if (
                                        case.get("cancel")
                                        and event["type"] == "text.delta"
                                    ):
                                        # Interrupt an actual pending HTTP receive, then
                                        # verify peer-side cancellation in the harness.
                                        pending = asyncio.create_task(anext(stream))
                                        await asyncio.sleep(0.02)
                                        pending.cancel()
                                        with self.assertRaises(asyncio.CancelledError):
                                            await pending
                                        cancelled = True
                                        break
                                    if event["type"] in {"run.failed", "run.cancelled"}:
                                        error = event["error"]
                                        raise DriverError(
                                            error["code"],
                                            error["message"],
                                            error["retryable"],
                                            error.get("outcome"),
                                        )
                                    if event["type"] == "run.completed":
                                        completed = True
                                        self.assertEqual(
                                            event["result"]["text"], "Hello 🌍"
                                        )
                                self.assertTrue(
                                    cancelled if case.get("cancel") else completed
                                )
                    except Exception as error:
                        failure = error
                if case.get("expectedError"):
                    self.assertIsInstance(failure, DriverError, str(failure))
                    self.assertEqual(failure.code, case["expectedError"])
                elif case.get("expectTransportError"):
                    self.assertIsNotNone(failure)
                elif failure:
                    raise failure

    async def test_scope_discovery_usage_replay_and_explicit_inactivity(self):
        request = {"provider": "mock", "model": "demo", "input": "Hello"}
        async with self.client() as client:
            self.assertEqual((await client.protocol())["version"], "1.0")
            provider = (await client.providers(refresh=True))[0]
            self.assertEqual(provider["health"]["code"], "DISCOVERY_UNSUPPORTED")
            self.assertEqual(provider["modelCatalog"]["source"], "configured")
            cost = await client.run(**dict(request, input="conformance-cost"))
            self.assertEqual(cost["usage"]["apiEquivalentCostUsd"], 0.25)
            self.assertNotIn("costUsd", cost["usage"])
            keyed = dict(
                request, idempotencyKey="python-async-client", retry={"maxAttempts": 1}
            )
            accepted = await client.run(**keyed)
            self.assertEqual(await client.run(**keyed), accepted)
            with self.assertRaises(DriverError) as error:
                await client.run(**dict(keyed, input="changed"))
            self.assertEqual(error.exception.code, "IDEMPOTENCY_CONFLICT")
            with self.assertRaises(DriverError) as error:
                await client.run(**dict(request, input="conformance-uncertain"))
            self.assertEqual(error.exception.outcome, "uncertain")
            self.assertFalse(error.exception.retryable)
            for mode, extra in [("quiet", {}), ("progress", {"idleTimeoutMs": 150})]:
                self.assertEqual(
                    (
                        await client.run(
                            **dict(request, input="conformance-" + mode), **extra
                        )
                    )["text"],
                    "AgenticDriver is connected.",
                )
            with self.assertRaises(DriverError) as error:
                await client.run(
                    **dict(request, input="conformance-stall"), idleTimeoutMs=30
                )
            self.assertEqual(error.exception.code, "IDLE_TIMEOUT")
        async with self.client(token="wrong-token") as client:
            with self.assertRaises(DriverError) as error:
                await client.run(**request)
            self.assertEqual(error.exception.code, "UNAUTHORIZED")
        async with self.client(
            token=os.environ["AGENTICDRIVER_TEST_TOKEN"] + "-restricted"
        ) as client:
            self.assertEqual(await client.providers(), [])
            with self.assertRaises(DriverError) as error:
                await client.run(**request)
            self.assertEqual(error.exception.code, "FORBIDDEN")
        if os.environ.get("AGENTICDRIVER_TEST_CA"):
            async with self.client(ca=False) as client:
                with self.assertRaises(Exception):
                    await client.providers()
            async with self.client(
                os.environ["AGENTICDRIVER_TEST_URL"].replace("127.0.0.1", "localhost")
            ) as client:
                with self.assertRaises(Exception):
                    await client.providers()

    async def test_context_retrieval_and_ingestion(self):
        async with self.client() as client:
            result = await client.run(
                provider="mock",
                model="demo",
                input="Summarize",
                attachments=[
                    {
                        "type": "reference",
                        "id": "source-one",
                        "revision": "r1",
                        "mediaType": "text/markdown",
                    }
                ],
                outputArtifact={"name": "answer.md", "mediaType": "text/markdown"},
            )
            self.assertEqual(result["sources"][0]["location"]["documentId"], "doc-one")
            self.assertEqual(result["artifacts"][0]["status"], "draft")
            document = {
                "corpus": "library",
                "source": {"id": "python-async-paper", "revision": "r1"},
                "chunks": [
                    {
                        "id": "python-async-p1",
                        "text": "Solar batteries retain energy.",
                        "location": {"page": 2},
                    }
                ],
            }
            self.assertEqual(
                (await client.index_context(document))["status"], "indexed"
            )
            query = {
                "corpus": "library",
                "sourceIds": ["python-async-paper"],
                "query": "solar energy",
            }
            self.assertEqual(
                (await client.search_context(query))["hits"][0]["chunkId"],
                "python-async-p1",
            )
            result = await client.run(
                provider="mock",
                model="demo",
                input="Question",
                retrieval=query,
                outputArtifact={"name": "answer.md", "mediaType": "text/markdown"},
            )
            self.assertEqual(result["sources"][0]["origin"], "retrieval")
            self.assertEqual(result["artifacts"][0]["sourceIds"], ["python-async-p1"])
            self.assertTrue(
                (
                    await client.delete_context(
                        {
                            "corpus": "library",
                            "sourceId": "python-async-paper",
                            "revision": "r1",
                        }
                    )
                )["deleted"]
            )
            self.assertEqual((await client.search_context(query))["hits"], [])
            for kind in ("markdown", "email", "pdf", "reference"):
                with self.subTest(kind=kind):
                    source = {
                        "id": (
                            "ingestion-reference"
                            if kind == "reference"
                            else "python-async-" + kind
                        ),
                        "revision": "r1",
                    }
                    documents = {
                        "markdown": {
                            "type": "text",
                            "source": source,
                            "mediaType": "text/markdown",
                            "text": "# Solar evidence\nEnergy from sunlight.",
                        },
                        "email": {
                            "type": "email",
                            "source": source,
                            "threadId": "thread-one",
                            "messages": [
                                {"id": "message-one", "text": "Solar evidence."}
                            ],
                        },
                        "pdf": {
                            "type": "pdf",
                            "source": source,
                            "mediaType": "application/pdf",
                            "data": "JVBERi0xLjQKJSVFT0YK",
                        },
                        "reference": {
                            "type": "reference",
                            **source,
                            "mediaType": "text/markdown",
                        },
                    }
                    receipt = await client.ingest_context(
                        {"corpus": "library", "document": documents[kind]}
                    )
                    self.assertEqual(
                        receipt["ingestion"]["format"],
                        "markdown" if kind == "reference" else kind,
                    )
                    self.assertEqual(
                        (
                            await client.ingest_context(
                                {"corpus": "library", "document": documents[kind]}
                            )
                        )["status"],
                        "unchanged",
                    )
                    result = await client.run(
                        provider="mock",
                        model="demo",
                        input="solar evidence",
                        retrieval={"corpus": "library", "sourceIds": [source["id"]]},
                    )
                    self.assertEqual(
                        result["retrieval"]["hits"][0]["ingestion"]["inputSha256"],
                        receipt["ingestion"]["inputSha256"],
                    )

    async def test_native_async_calls_leave_the_event_loop_responsive(self):
        ticks = 0

        async def tick():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        ticker = asyncio.create_task(tick())
        try:
            async with self.client() as client:
                results = await asyncio.gather(
                    *(
                        client.run(
                            provider="mock", model="demo", input="conformance-quiet"
                        )
                        for _ in range(3)
                    )
                )
                self.assertEqual(len(results), 3)
                self.assertGreater(ticks, 1)
        finally:
            ticker.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await ticker
