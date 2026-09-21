import os
from pathlib import Path
from agenticdriver import AgenticClient

# Obtain a current token from the application's Better Auth credential manager.
token = Path(os.environ["AGENTICDRIVER_TOKEN_FILE"]).read_text(encoding="utf8").strip()
with AgenticClient(
    os.environ["AGENTICDRIVER_URL"], token,
    ca_file=os.environ.get("AGENTICDRIVER_CA"),
) as client:
    result = client.run(
        provider=os.environ["AGENTICDRIVER_PROVIDER"],
        model=os.environ["AGENTICDRIVER_MODEL"],
        input="Say hello in one sentence.",
    )
    print(result["text"])
