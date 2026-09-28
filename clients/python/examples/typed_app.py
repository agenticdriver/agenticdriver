"""Installed-wheel example using the explicitly selected real connection."""
import os
from pathlib import Path
from agenticdriver import AgenticClient, AsyncAgenticClient, RunRequest

def request() -> RunRequest:
    return {"provider": os.environ["AGENTICDRIVER_PROVIDER"],
            "model": os.environ["AGENTICDRIVER_MODEL"],
            "input": Path(os.environ["AGENTICDRIVER_INPUT_FILE"]).read_text()}

def sync_main() -> None:
    with AgenticClient(os.environ["AGENTICDRIVER_URL"],
                      Path(os.environ["AGENTICDRIVER_TOKEN_FILE"]).read_text().strip(),
                      ca_file=os.environ.get("AGENTICDRIVER_CA")) as client:
        print(client.run(**request())["text"])

async def async_main() -> None:
    async with AsyncAgenticClient(os.environ["AGENTICDRIVER_URL"],
                                 Path(os.environ["AGENTICDRIVER_TOKEN_FILE"]).read_text().strip(),
                                 ca_file=os.environ.get("AGENTICDRIVER_CA")) as client:
        result = await client.run(**request())
        print(result["text"])

if __name__ == "__main__":
    sync_main()
