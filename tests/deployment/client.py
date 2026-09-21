import asyncio
import os
from agenticdriver import AgenticClient, AsyncAgenticClient

options = {"ca_file": os.environ["AGENTICDRIVER_TEST_CA"]}
url, token = os.environ["AGENTICDRIVER_TEST_URL"], os.environ["AGENTICDRIVER_TEST_TOKEN"]
request = {"provider": "fixture", "model": "fixture-model", "input": "Deployment check"}
with AgenticClient(url, token, **options) as client:
    assert client.protocol()["version"] == "1.0"
    assert client.providers()[0]["id"] == "fixture"
    assert client.run(**request)["text"] == "Remote deployment works."
    with client.stream(**request) as stream:
        assert list(stream)[-1]["type"] == "run.completed"


async def main():
    async with AsyncAgenticClient(url, token, **options) as client:
        assert (await client.run(**request))["text"] == "Remote deployment works."
        async with client.stream(**request) as stream:
            events = [event async for event in stream]
            assert events[-1]["type"] == "run.completed"


asyncio.run(main())
print("Installed Python sync/async clients passed through verified TLS proxy.")
