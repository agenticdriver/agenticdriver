"""Build/install a wheel in an isolated application; never an editable checkout."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def prepare_python(directory: Path):
    application = directory / "python-application"
    application.mkdir()
    build_env = directory / "python-build-env"
    app_env = application / ".venv"

    def python_at(folder):
        return folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    for folder in (build_env, app_env):
        subprocess.run(
            [sys.executable, "-m", "venv", str(folder)], check=True, timeout=90
        )
    builder, python = python_at(build_env), python_at(app_env)
    wheels = directory / "python-wheels"
    subprocess.run(
        [
            str(builder),
            "-m",
            "pip",
            "wheel",
            "--quiet",
            "--no-deps",
            "--wheel-dir",
            str(wheels),
            str(ROOT / "clients/python"),
        ],
        check=True,
        timeout=180,
    )
    (wheel,) = wheels.glob("agenticdriver-*.whl")
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert "agenticdriver/py.typed" in names
        assert any(name.endswith("/licenses/LICENSE") for name in names)
        assert not any(name.startswith("tests/") for name in names)
    subprocess.run(
        [str(python), "-m", "pip", "install", "--quiet", str(wheel)],
        check=True,
        cwd=application,
        timeout=120,
    )
    clean_env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "PYTHONHOME"}
    }
    subprocess.run(
        [
            str(python),
            "-c",
            """
import importlib.util
from agenticdriver import AgenticClient, AsyncAgenticClient, RunRequest
assert importlib.util.find_spec('httpx') is None
with AgenticClient('http://127.0.0.1:7433', 'test-only'):
    pass
try:
    AsyncAgenticClient('http://127.0.0.1:7433', 'test-only')
except ImportError as error:
    assert 'agenticdriver[async]' in str(error)
else:
    raise AssertionError('Async optional dependency was not required')
""",
        ],
        check=True,
        cwd=application,
        env=clean_env,
        timeout=15,
    )
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--quiet",
            str(wheel) + "[async]",
            "mypy>=1.18,<2",
        ],
        check=True,
        cwd=application,
        timeout=120,
    )
    shutil.copyfile(
        ROOT / "clients/python/examples/typed_app.py", application / "app.py"
    )
    subprocess.run(
        [str(python), "-m", "mypy", "--python-version", "3.10", "--strict", "app.py"],
        check=True,
        cwd=application,
        env=clean_env,
        timeout=90,
    )
    subprocess.run(
        [str(python), "-m", "mypy", "--check-untyped-defs", "-p", "agenticdriver"],
        check=True,
        cwd=application,
        env=clean_env,
        timeout=90,
    )
    (application / "invalid.py").write_text(
        """from agenticdriver import AgenticClient, RunEvent
client = AgenticClient('https://driver.example', 'test-only')
client.run(providre='mock', model='demo', input='Hello')
client.run(provider='mock', model=123, input='Hello')
def incorrect(event: RunEvent) -> None:
    if event['type'] == 'text.delta':
        print(event['result'])
"""
    )
    result = subprocess.run(
        [str(python), "-m", "mypy", "--strict", "invalid.py"],
        cwd=application,
        env=clean_env,
        text=True,
        capture_output=True,
        timeout=90,
    )
    assert result.returncode == 1 and all(
        code in result.stdout
        for code in ["[call-arg]", "[arg-type]", "[typeddict-item]"]
    ), (result.stdout + result.stderr)
    print(
        "Installed Python wheel: base/async dependencies, license, py.typed and positive/negative type checks passed.",
        flush=True,
    )
    return str(python), application
