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
                        stream = client.stream(provider="mock", model="demo", input="Hello")
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

    def test_real_host_scope_progress_and_tls(self):
        refreshed = self.client().providers(refresh=True)[0]
        self.assertEqual(refreshed["health"]["code"], "DISCOVERY_UNSUPPORTED")
        self.assertEqual(refreshed["modelCatalog"]["source"], "configured")
        request = {"provider": "mock", "model": "demo", "input": "Hello"}
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
