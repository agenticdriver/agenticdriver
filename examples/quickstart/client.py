import os
from pathlib import Path
from agenticdriver import AgenticClient

# Use the private scoped credential issued by the selected AgenticDriver host.
token = Path(os.environ["AGENTICDRIVER_TOKEN_FILE"]).read_text(encoding="utf8").strip()
with AgenticClient(
    os.environ["AGENTICDRIVER_URL"], token,
    ca_file=os.environ.get("AGENTICDRIVER_CA"),
) as client:
    result = client.run(
        provider=os.environ["AGENTICDRIVER_PROVIDER"],
        model=os.environ["AGENTICDRIVER_MODEL"],
        input=Path(os.environ["AGENTICDRIVER_INPUT_FILE"]).read_text(encoding="utf8"),
    )
    print(result["text"])
