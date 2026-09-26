from agenticdriver.panel import AsyncProviderPanel
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

    async def test_provider_management_roundtrip(self):
        async with self.client(os.environ["AGENTICDRIVER_TEST_MANAGEMENT_URL"]) as client:
            before = await client.management()
            panel = AsyncProviderPanel(lambda: client)
            panel_state = await panel.handle({"action": "configure", "change": {"revision": before["revision"], "provider": {"kind": "mock", "id": "python-async", "models": []}}})
            next_state = panel_state["management"]
            self.assertEqual(next_state["providerDefinitions"], before["providerDefinitions"])
            self.assertEqual(next(d for d in before["providerDefinitions"] if d["kind"] == "codex")["methods"][0]["interaction"], "external")
            self.assertEqual(next(p for p in panel_state["providers"] if p["id"] == "python-async")["models"], [])
            self.assertIsInstance(next_state["executionProviders"], list)
            self.assertEqual(next(p for p in next_state["providers"] if p["id"] == "python-async")["models"], [])
            with self.assertRaises(DriverError) as failure:
                await client.configure_provider({"revision": before["revision"], "provider": {"kind": "mock", "id": "python-async"}})
            self.assertEqual(failure.exception.code, "CONFIG_CONFLICT")

    async def test_connection_pairing(self):
        url = os.environ["AGENTICDRIVER_TEST_MANAGEMENT_URL"]
        async with self.client(url) as manager:
            invitation = await manager.create_invitation({"grant": {"subject": "python-pairing", "providers": ["fixture"]}})
            async with self.client(url, token=invitation["code"]) as pairing:
                credential = await pairing.exchange_connection()
                with self.assertRaises(DriverError) as rejected:
                    await pairing.exchange_connection()
                self.assertEqual(rejected.exception.code, "INVITATION_REJECTED")
            async with self.client(url, token=credential["token"]) as connected:
                self.assertEqual((await connected.providers())[0]["id"], "fixture")
                with self.assertRaises(DriverError) as forbidden:
                    await connected.management()
                self.assertEqual(forbidden.exception.code, "FORBIDDEN")
                self.assertTrue(await manager.revoke_connection(credential["id"]))
                with self.assertRaises(DriverError) as revoked:
                    await connected.providers()
                self.assertEqual(revoked.exception.code, "UNAUTHORIZED")

    async def test_wire_cases(self):
        fixture = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "protocol/fixtures/conformance.json"
            ).read_text(encoding="utf-8")
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
                        elif case.get("operation") == "job-submit":
                            await client.submit_job(case["jobSubmit"])
                        elif case.get("operation") == "job-read":
                            await client.read_job(case["jobIdentity"])
                        elif case.get("operation") == "job-cancel":
                            await client.cancel_job(case["jobIdentity"])
                        elif case.get("operation") == "job-events":
                            await client.job_events(case["jobEvents"])
                        elif case.get("operation") == "session-create":
                            await client.create_session(case["sessionCreate"])
                        elif case.get("operation") == "session-read":
                            await client.read_session(case["sessionIdentity"])
                        elif case.get("operation") == "session-delete":
                            await client.delete_session(case["sessionIdentity"])
                        elif case.get("operation") == "tool-result":
                            await client.complete_tool(case["toolResult"])
                        elif case.get("operation") == "tool-progress":
                            await client.report_tool_progress(case["toolIdentity"])
                        elif case.get("operation") == "approval":
                            await client.decide_approval(case["decision"])
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
                                **({k: case[k] for k in ["applicationTools", "tools", "session"] if k in case}),

                                **({"approvals": case["approvals"]} if "approvals" in case else {}),
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

    async def test_interactive_approvals(self):
        async with self.client() as client:
            for action in ("approve", "deny", "cancel", "expire"):
                events = []
                policy = {"mode": "interactive", "idlePolicy": "pause"}
                if action == "expire": policy["expiresAfterMs"] = 20
                async with client.stream(provider="mock", model="demo", input="conformance-approval", tools=["approved_echo"], approvals=policy) as stream:
                    async for event in stream:
                        events.append(event)
                        if event["type"] == "approval.requested" and action != "expire":
                            approval = event["approval"]
                            decision = {k: approval[k] for k in ("approvalId", "runId", "call")}
                            decision["decision"] = action
                            receipt = await client.decide_approval(decision)
                            self.assertEqual(receipt["callId"], approval["call"]["id"])
                            with self.assertRaises(DriverError) as stale:
                                await client.decide_approval(decision)
                            self.assertEqual(stale.exception.code, "APPROVAL_NOT_FOUND")
                self.assertEqual(events[-1]["type"], "run.completed" if action == "approve" else "run.cancelled" if action == "cancel" else "run.failed")
                self.assertEqual(any(e["type"] == "tool.completed" for e in events), action == "approve")
                resolution = next(e["resolution"] for e in events if e["type"] == "approval.resolved")
                self.assertEqual(resolution["outcome"], {"approve": "approved", "deny": "denied", "cancel": "cancelled", "expire": "expired"}[action])

    async def test_application_owned_function(self):
        async with self.client() as client:
            for review in (False, True):
                calls = []
                def lookup(arguments):
                    calls.append(arguments)
                    return {"passages": ["Evidence for " + arguments["query"]]}
                definition = {"name": "application_lookup", "description": "Find application-owned evidence", "inputSchema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}}, "outputSchema": {"type": "object", "required": ["passages"], "properties": {"passages": {"type": "array", "items": {"type": "string"}}}}, "requiresApproval": review}
                extra = {"approvals": {"mode": "interactive", "idlePolicy": "pause"}} if review else {}
                approved = completed = False
                async with client.stream(provider="mock", model="demo", input="conformance-application-tool", tools=["application_lookup"], applicationTools=[definition], **extra) as stream:
                    async for event in stream:
                        if event["type"] == "approval.requested":
                            approval = event["approval"]
                            await client.decide_approval({"approvalId": approval["approvalId"], "runId": approval["runId"], "call": approval["call"], "decision": "approve"})
                            approved = True
                        if event["type"] == "tool.execution.requested":
                            self.assertEqual(approved, review)
                            execution = event["execution"]
                            identity = {"executionId": execution["executionId"], "runId": execution["runId"], "callId": execution["call"]["id"]}
                            output = lookup(execution["call"]["arguments"])
                            receipt = await client.report_tool_progress(identity)
                            self.assertEqual(receipt["status"], "progress")
                            receipt = await client.complete_tool({**identity, "output": output})
                            self.assertEqual(receipt["status"], "accepted")
                            with self.assertRaises(DriverError) as stale:
                                await client.complete_tool({**identity, "output": output})
                            self.assertEqual(stale.exception.code, "TOOL_EXECUTION_NOT_FOUND")
                        if event["type"] in ("run.failed", "run.cancelled"): self.fail(event["error"]["code"])
                        if event["type"] == "run.completed": completed = True
                self.assertEqual(len(calls), 1)
                self.assertTrue(completed)

    async def test_durable_jobs(self):
        async with self.client() as client:
            request = {"key": "python-async-job", "request": {"provider": "mock", "model": "demo", "input": "Hello"}}
            job = await client.submit_job(request)
            self.assertEqual((await client.submit_job(request))["id"], job["id"])
            identity = {"id": job["id"]}
            for _ in range(200):
                job = await client.read_job(identity)
                if job["state"] == "completed": break
                await asyncio.sleep(0.01)
            self.assertEqual(job["state"], "completed")
            cursor = 0
            while cursor < job["cursor"]:
                page = await client.job_events({**identity, "after": cursor, "limit": 2})
                cursor = page["nextCursor"]
            self.assertEqual((await client.cancel_job(identity))["state"], "completed")
            stalled = await client.submit_job({"key": "python-async-job-cancel", "request": {"provider":"mock","model":"demo","input":"conformance-stall"}})
            identity = {"id": stalled["id"]}
            await client.cancel_job(identity)
            for _ in range(200):
                job = await client.read_job(identity)
                if job["state"] == "cancelled": break
                await asyncio.sleep(0.01)
            self.assertEqual(job["state"], "cancelled")

    async def test_conversation_sessions(self):
        async with self.client() as client:
            for mode in ("history", "native"):
                created = await client.create_session({"provider":"mock", "model":"demo", "mode":mode})
                identity = {"id":created["session"]["id"]}
                first = await client.run(provider="mock", model="demo", input="session-first", session={**identity, "revision":0})
                self.assertEqual(first["session"]["revision"],1)
                with self.assertRaises(DriverError) as stale:
                    await client.run(provider="mock", model="demo", input="session-next", session={**identity, "revision":0})
                self.assertEqual(stale.exception.code,"SESSION_REVISION_CONFLICT")
                saved = await client.read_session(identity)
                self.assertEqual(len(saved["history"]),2)
                self.assertNotIn("private-state",json.dumps(saved))
                completed = False
                async with client.stream(provider="mock",model="demo",input="session-next",session={**identity,"revision":1}) as stream:
                    async for event in stream:
                        if event["type"] == "run.completed":
                            self.assertEqual(event["result"]["text"],"continued")
                            self.assertEqual(event["result"]["session"]["revision"],2)
                            completed = True
                        if event["type"] in ("run.failed","run.cancelled"): self.fail(event["error"]["code"])
                self.assertTrue(completed)
                result = await client.delete_session(identity)
                self.assertTrue(result["deleted"])
                with self.assertRaises(DriverError) as deleted:
                    await client.read_session(identity)
                self.assertEqual(deleted.exception.code,"SESSION_NOT_FOUND")
