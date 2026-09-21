"""Installed-wheel example; use only the disposable harness account below."""

import asyncio
import os
from agenticdriver import (
    AgenticClient,
    AsyncAgenticClient,
    RunRequest,
    RunResult,
    RunEvent,
    ProviderInfo,
    IngestRequest,
    RetrievalSearch,
)

request: RunRequest = {
    "provider": "mock",
    "model": "demo",
    "input": "Installed Python 🌍",
}


def visible_text(event: RunEvent) -> str:
    if event["type"] == "run.completed":
        return event["result"]["text"]
    if event["type"] == "text.delta":
        return event["text"]
    return ""


def sync_main() -> None:
    with AgenticClient(
        os.environ["AGENTICDRIVER_TEST_URL"],
        os.environ["AGENTICDRIVER_TEST_TOKEN"],
        ca_file=os.environ.get("AGENTICDRIVER_TEST_CA"),
    ) as client:
        providers: list[ProviderInfo] = client.providers()
        assert providers[0]["id"] == "mock"
        result: RunResult = client.run(**request)
        assert result["text"] == "AgenticDriver is connected."
        with client.stream(**request) as stream:
            assert list(stream)[-1]["type"] == "run.completed"


async def async_main() -> None:
    async with AsyncAgenticClient(
        os.environ["AGENTICDRIVER_TEST_URL"],
        os.environ["AGENTICDRIVER_TEST_TOKEN"],
        ca_file=os.environ.get("AGENTICDRIVER_TEST_CA"),
    ) as client:
        result: RunResult = await client.run(**request)
        assert result["text"] == "AgenticDriver is connected."
        async with client.stream(**request) as stream:
            events = [event async for event in stream]
            assert visible_text(events[-1]) == result["text"]
        ingest: IngestRequest = {
            "corpus": "library",
            "document": {
                "type": "reference",
                "id": "ingestion-reference",
                "revision": "r1",
                "mediaType": "text/markdown",
            },
        }
        receipt = await client.ingest_context(ingest)
        query: RetrievalSearch = {
            "corpus": "library",
            "sourceIds": ["ingestion-reference"],
            "query": "solar",
        }
        answer = await client.run(
            provider="mock", model="demo", input="solar", retrieval=query
        )
        assert (
            answer["retrieval"]["hits"][0]["ingestion"]["inputSha256"]
            == receipt["ingestion"]["inputSha256"]
        )


if __name__ == "__main__":
    sync_main()
    asyncio.run(async_main())
