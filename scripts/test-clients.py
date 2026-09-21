"""Exercise all four SDK clients against real HTTP and certificate-verified HTTPS hosts."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import ssl
import time
from urllib.request import Request, urlopen
from python_package import prepare_python
from rust_package import prepare_rust, TOOLCHAIN
from tls_fixture import create_tls_fixture

ROOT = Path(__file__).resolve().parent.parent
PYTHON_ONLY = "--python-only" in sys.argv[1:]
RUST_ONLY = "--rust-only" in sys.argv[1:]
assert not (PYTHON_ONLY and RUST_ONLY), "Choose at most one language filter"


def check_clients(url, token, ca, env, python, application, rust_application, rust_env):
    env = {key: value for key, value in env.items() if key not in {"PYTHONPATH", "PYTHONHOME"}}
    commands = []
    if not RUST_ONLY:
        commands += [([python, "app.py"], application),
                     ([python, "-m", "unittest", "discover", "-s", "clients/python/tests"], ROOT)]
    if not PYTHON_ONLY and not RUST_ONLY:
        commands += [(["node", "--import", "tsx", "tests/client-smoke.ts"], ROOT), (["node", "--import", "tsx", "tests/client-conformance.ts"], ROOT), (["go", "test", "-race", "-count=1", "./..."], ROOT / "clients/go")]
    if not PYTHON_ONLY:
        env.update(rust_env)
        commands += [(["cargo", f"+{TOOLCHAIN}", "run", "--locked", "--quiet"], rust_application), (["cargo", f"+{TOOLCHAIN}", "test", "--locked", "--quiet"], ROOT / "clients/rust")]
    failures = []
    for command, directory in commands:
        result = subprocess.run(command, cwd=directory, env=env, timeout=180)
        if result.returncode:
            failures.append(command)
    assert not failures, f"Client checks failed: {failures}"
    expected_cancellations = 2 if PYTHON_ONLY or RUST_ONLY else 6
    for attempt in range(50):
        request = Request(env["AGENTICDRIVER_TEST_REFERENCE_URL"] + "/metrics", headers={"Authorization": "Bearer " + token})
        with urlopen(request, context=ssl.create_default_context(cafile=ca), timeout=5) as response:
            metrics = json.load(response)
        if metrics["cancelled"] == expected_cancellations:
            break
        time.sleep(0.02)
    assert metrics["cancelled"] == expected_cancellations, metrics
    assert metrics["redirects"] == 0, metrics
    print(f"Client checks passed ({url.split(':')[0]}); peer confirmed {expected_cancellations} cancellations and no redirects.", flush=True)


with tempfile.TemporaryDirectory(prefix="agenticdriver-client-test-") as directory:
    python, application = (None, None) if RUST_ONLY else prepare_python(Path(directory))
    rust_application, rust_env = (None, {}) if PYTHON_ONLY else prepare_rust(Path(directory))
    ca, cert, key = create_tls_fixture(Path(directory))
    for secure in [False, True]:
        token = secrets.token_urlsafe(32)
        env = {key: value for key, value in os.environ.items() if not key.startswith("AGENTICDRIVER_")}
        env.update(AGENTICDRIVER_PROVIDER="mock", AGENTICDRIVER_PORT="0", AGENTICDRIVER_TOKEN=token)
        if secure:
            env.update(AGENTICDRIVER_TLS_CERT=cert, AGENTICDRIVER_TLS_KEY=key, NODE_EXTRA_CA_CERTS=ca)
        server = subprocess.Popen(["node", "--import", "tsx", "tests/conformance-host.ts"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
        try:
            hosts = json.loads(server.stdout.readline())
            url = hosts["url"]
            env.update(AGENTICDRIVER_TEST_URL=url, AGENTICDRIVER_TEST_TOKEN=token, AGENTICDRIVER_TEST_REFERENCE_URL=hosts["referenceUrl"])
            if secure:
                env["AGENTICDRIVER_TEST_CA"] = ca
            check_clients(url, token, ca if secure else None, env, python, application, rust_application, rust_env)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
print(("Python clients" if PYTHON_ONLY else "Rust clients" if RUST_ONLY else "All four language clients") + " passed over HTTP and verified HTTPS.")
