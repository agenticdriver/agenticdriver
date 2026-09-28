import json
import unittest
from pathlib import Path
from agenticdriver import DriverError
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

    def test_mismatched_or_malformed_snapshots_fail(self):
        for value in [{}, {**FIXTURE, "revision": "invalid"}, {**FIXTURE, "providers": [FIXTURE["providers"][0]] * 2}]:
            with self.assertRaises(DriverError): snapshot(value)
        with self.assertRaises(DriverError): snapshot(FIXTURE, "wrong-instance")
