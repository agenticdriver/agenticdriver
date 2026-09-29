"""Search an explicitly selected real corpus; stdout contains source passages."""
import json
import os
from pathlib import Path
from agenticdriver import AgenticClient

with AgenticClient(
    os.environ["AGENTICDRIVER_URL"],
    Path(os.environ["AGENTICDRIVER_TOKEN_FILE"]).read_text().strip(),
) as client:
    evidence = client.search_context({
        "corpus": os.environ["AGENTICDRIVER_CORPUS"],
        "sourceIds": [os.environ["AGENTICDRIVER_SOURCE_ID"]],
        "query": Path(os.environ["AGENTICDRIVER_QUERY_FILE"]).read_text(),
        "limit": 4,
    })
    print(json.dumps(evidence, indent=2))
