import json
import os
import unittest
from pathlib import Path

from agenticdriver import AgenticClient, DriverError


@unittest.skipUnless(os.environ.get("AGENTICDRIVER_TEST_REFERENCE_URL"), "requires the reference host")
class ClientConformance(unittest.TestCase):
    def client(self, url=None, token=None, ca=True):
        return AgenticClient(url or os.environ["AGENTICDRIVER_TEST_URL"], token or os.environ["AGENTICDRIVER_TEST_TOKEN"], ca_file=os.environ.get("AGENTICDRIVER_TEST_CA") if ca else None)

    def test_wire_cases(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / "protocol/fixtures/conformance.json").read_text())
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                client = self.client(os.environ["AGENTICDRIVER_TEST_REFERENCE_URL"] + "/fixtures/" + case["id"])
                failure = None
                try:
                    if case.get("operation") == "providers":
                        client.providers()
                    elif case.get("operation") == "protocol":
                        client.protocol()
                    else:
                        stream = client.stream(provider="mock", model="demo", input="Hello", **({"retrieval": case["retrieval"]} if "retrieval" in case else {}))
                        completed = cancelled = False
                        try:
                            for event in stream:
                                if case.get("cancel") and event["type"] == "text.delta":
                                    cancelled = True
                                    break
                                if event["type"] in {"run.failed", "run.cancelled"}:
                                    error = event.get("error", {})
                                    raise DriverError(error.get("code", "MISSING_ERROR"), error.get("message", "Missing failure details"), error.get("retryable", False))
                                if event["type"] == "run.completed":
                                    completed = True
                                    self.assertEqual(event["result"]["text"], "Hello 🌍")
                        finally:
                            stream.close()
                        self.assertTrue(cancelled if case.get("cancel") else completed)
                except Exception as error:
                    failure = error
                if case.get("expectedError"):
                    self.assertIsInstance(failure, DriverError, str(failure))
                    self.assertEqual(failure.code, case["expectedError"])
                elif case.get("expectTransportError"):
                    self.assertIsNotNone(failure)
                elif failure:
                    raise failure

    def test_context_and_draft_artifacts(self):
        from agenticdriver import ContextReference, ContextInput, ArtifactRequest
        reference: ContextReference = {"type":"reference","id":"source-one","revision":"r1","mediaType":"text/markdown"}
        inputs: list[ContextInput] = [reference,
            {"type":"image","source":{"id":"image-one","revision":"r1"},"mediaType":"image/png","data":"iVBORw0KGgo="},
            {"type":"pdf","source":{"id":"pdf-one","revision":"r1"},"mediaType":"application/pdf","data":"JVBERi0xLjQKJSVFT0YK"}]
        output: ArtifactRequest = {"name":"answer.md","mediaType":"text/markdown"}
        result = self.client().run(provider="mock",model="demo",input="Summarize",attachments=inputs,outputArtifact=output)
        self.assertEqual([source["id"] for source in result["sources"]], ["source-one","image-one","pdf-one"])
        self.assertEqual(result["sources"][0]["location"]["documentId"],"doc-one")
        self.assertEqual(result["artifacts"][0]["status"],"draft")
        self.assertEqual(result["artifacts"][0]["sourceIds"],["source-one","image-one","pdf-one"])
        self.assertEqual(self.client().providers()[0]["inputMediaTypes"]["demo"],["image/png","application/pdf"])

    def test_real_host_scope_progress_and_tls(self):
        refreshed = self.client().providers(refresh=True)[0]
        self.assertEqual(refreshed["health"]["code"], "DISCOVERY_UNSUPPORTED")
        self.assertEqual(refreshed["modelCatalog"]["source"], "configured")
        request = {"provider": "mock", "model": "demo", "input": "Hello"}
        estimated = self.client().run(**dict(request, input="conformance-cost"))
        self.assertEqual(estimated["usage"]["apiEquivalentCostUsd"], 0.25)
        self.assertNotIn("costUsd", estimated["usage"])
        keyed = dict(request, idempotencyKey="python-client", retry={"maxAttempts": 1})
        accepted = self.client().run(**keyed)
        self.assertEqual(self.client().run(**keyed), accepted)
        with self.assertRaises(DriverError) as conflict:
            self.client().run(**dict(keyed, input="changed"))
        self.assertEqual(conflict.exception.code, "IDEMPOTENCY_CONFLICT")
        with self.assertRaises(DriverError) as uncertain:
            self.client().run(**dict(request, input="conformance-uncertain"))
        self.assertEqual(uncertain.exception.outcome, "uncertain")
        self.assertEqual(uncertain.exception.code, "IDLE_TIMEOUT")
        self.assertFalse(uncertain.exception.retryable)
        with self.assertRaises(DriverError) as error:
            self.client(token="wrong-token").run(**request)
        self.assertEqual(error.exception.code, "UNAUTHORIZED")
        restricted = self.client(token=os.environ["AGENTICDRIVER_TEST_TOKEN"] + "-restricted")
        self.assertEqual(restricted.providers(), [])
        with self.assertRaises(DriverError) as error:
            restricted.run(**request)
        self.assertEqual(error.exception.code, "FORBIDDEN")
        with self.assertRaises(DriverError) as error:
            self.client().run(**request, tools=["echo"])
        self.assertEqual(error.exception.code, "FORBIDDEN")
        for mode, extra in [("quiet", {}), ("progress", {"idleTimeoutMs": 150})]:
            self.assertEqual(self.client().run(**dict(request, input="conformance-" + mode), **extra)["text"], "AgenticDriver is connected.")
        with self.assertRaises(DriverError) as error:
            self.client().run(**dict(request, input="conformance-stall"), idleTimeoutMs=30)
        self.assertEqual(error.exception.code, "IDLE_TIMEOUT")
        if os.environ.get("AGENTICDRIVER_TEST_CA"):
            with self.assertRaises(Exception):
                self.client(ca=False).providers()
            with self.assertRaises(Exception):
                self.client(os.environ["AGENTICDRIVER_TEST_URL"].replace("127.0.0.1", "localhost")).providers()

    def test_retrieval(self):
        from agenticdriver import RetrievalIndexRequest, RetrievalSearch
        client = self.client()
        document: RetrievalIndexRequest = {"corpus": "library", "source": {"id": "python-paper", "revision": "r1"},
            "chunks": [{"id": "python-p1", "text": "Solar batteries retain energy.", "location": {"page": 2}}]}
        self.assertEqual(client.index_context(document)["status"], "indexed")
        query: RetrievalSearch = {"corpus": "library", "sourceIds": ["python-paper"], "query": "solar energy"}
        self.assertEqual(client.search_context(query)["hits"][0]["chunkId"], "python-p1")
        result = client.run(provider="mock", model="demo", input="Question", retrieval=query,
            outputArtifact={"name": "answer.md", "mediaType": "text/markdown"})
        self.assertEqual(result["retrieval"]["hits"][0]["source"]["id"], "python-paper")
        self.assertEqual(result["sources"][0]["origin"], "retrieval")
        self.assertEqual(result["artifacts"][0]["sourceIds"], ["python-p1"])
        self.assertTrue(client.delete_context({"corpus": "library", "sourceId": "python-paper", "revision": "r1"})["deleted"])
        self.assertEqual(client.search_context(query)["hits"], [])
