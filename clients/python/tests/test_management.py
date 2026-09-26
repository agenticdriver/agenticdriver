import io
import json
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from agenticdriver import AgenticClient, DriverError
from agenticdriver.management import snapshot

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "protocol/fixtures/management.json").read_text())

class Management(unittest.TestCase):
    def test_setup_catalog_and_native_tool_roundtrip(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / "protocol/fixtures/management-catalog.json").read_text())
        state = snapshot(fixture)
        self.assertEqual(state["providerDefinitions"][0]["methods"][0]["credentialOwner"], "native-runtime")
        self.assertEqual(state["providers"][0]["applicationTools"], "mcp")
        self.assertEqual(state["providers"][0]["models"], [])
        self.assertEqual(json.loads(json.dumps(state)), fixture)
        for definitions in [None, {}, [{**fixture["providerDefinitions"][0], "methods": []}], [{**fixture["providerDefinitions"][0], "docsUrl": "javascript:alert(1)"}]]:
            with self.assertRaises(DriverError): snapshot({**fixture, "providerDefinitions": definitions})

    def test_wire_and_model_overrides(self):
        calls = []
        def open_response(request, timeout):
            calls.append(request)
            response = io.BytesIO(json.dumps(FIXTURE).encode())
            response.headers = Message()
            return response
        with AgenticClient("https://driver.example", "fixture-operator") as client:
            client._opener = SimpleNamespace(open=open_response)
            state = client.management()
            self.assertNotIn("models", state["providers"][0])
            self.assertEqual(state["providers"][1]["models"], [])
            client.configure_provider({"revision": state["revision"], "provider": state["providers"][1]})
        self.assertEqual(calls[0].full_url, "https://driver.example/v1/management")
        self.assertEqual(calls[1].full_url, "https://driver.example/v1/management/providers")
        self.assertEqual(json.loads(calls[1].data)["provider"]["models"], [])

    def test_mismatched_or_malformed_snapshots_fail(self):
        for value in [{}, {**FIXTURE, "revision": "invalid"}, {**FIXTURE, "providers": [FIXTURE["providers"][0]] * 2}]:
            with self.assertRaises(DriverError): snapshot(value)
        with self.assertRaises(DriverError): snapshot(FIXTURE, "wrong-instance")
