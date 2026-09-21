import io
import json
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

from agenticdriver import AgenticClient, DriverError, PROTOCOL_VERSION
from urllib.error import HTTPError


class ProtocolCompatibility(unittest.TestCase):
    def test_shared_version_fixtures(self):
        fixtures = json.loads((Path(__file__).resolve().parents[3] / "protocol/fixtures/versioning.json").read_text(encoding="utf-8"))
        for case in fixtures["cases"]:
            with self.subTest(case=case["id"]):
                headers = Message()
                headers["Content-Type"] = "text/event-stream" if "events" in case else "application/json"
                for key, value in case["headers"].items():
                    headers[key] = value
                body = ("".join("data: " + json.dumps(e) + "\n\n" for e in case["events"]) if "events" in case else json.dumps(case["json"])).encode()
                response = io.BytesIO(body)
                response.headers = headers

                def open_response(request, timeout):
                    sent = {k.lower(): v for k, v in request.header_items()}
                    self.assertEqual(sent["agenticdriver-version"], PROTOCOL_VERSION)
                    self.assertEqual(sent["agenticdriver-accept-optional-events"], "true")
                    self.assertIsNone(timeout)
                    if case.get("status", 200) >= 400:
                        raise HTTPError(request.full_url, case["status"], "Failure", headers, response)
                    return response

                client = AgenticClient("https://driver.example", "fixture-token")
                client._opener = SimpleNamespace(open=open_response)
                try:
                    events = list(client.stream(provider="mock", model="demo", input="Hello"))
                    self.assertNotIn("expectedError", case)
                    self.assertEqual([e["type"] for e in events], case["expectedTypes"])
                    self.assertEqual(events[-1]["result"]["text"], "Hello 🌍")
                except DriverError as error:
                    self.assertEqual(error.code, case.get("expectedError"))
                    if "retryable" in case:
                        self.assertEqual(error.retryable, case["retryable"])
                finally:
                    self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
