"""Use the same ephemeral CA/leaf chain as the Node network fault checks."""
import json
from pathlib import Path
import subprocess


def create_tls_fixture(directory: Path) -> tuple[str, str, str]:
    root = Path(__file__).resolve().parent.parent
    result = subprocess.run(
        ["node", "--import", "tsx", "tests/tls-fixture.ts", str(directory)],
        cwd=root, check=True, text=True, capture_output=True, timeout=60,
    )
    paths = json.loads(result.stdout)
    return paths["ca"], paths["cert"], paths["key"]
