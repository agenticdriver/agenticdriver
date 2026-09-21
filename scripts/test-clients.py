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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "clients/python/src"))
from agenticdriver import AgenticClient, DriverError


def check_clients(url, token, ca, env):
    client = AgenticClient(url, token, ca_file=ca)
    assert client.providers()[0]["id"] == "mock"
    assert client.protocol()["version"] == "1.0"
    request = {"provider": "mock", "model": "demo", "input": "Unicode 🌍 round trip", "idleTimeoutMs": 10_000}
    assert client.run(**request)["text"] == "AgenticDriver is connected."
    assert list(client.stream(**request))[-1]["type"] == "run.completed"
    try:
        AgenticClient(url, "wrong-token", ca_file=ca).run(**request)
        raise AssertionError("unauthorized request succeeded")
    except DriverError as error:
        assert error.code == "UNAUTHORIZED"
    print(f"Python client passed ({url.split(':')[0]})", flush=True)
    env = {**env, "PYTHONPATH": str(ROOT / "clients/python/src")}
    commands = [([sys.executable, "-m", "unittest", "discover", "-s", "clients/python/tests"], ROOT), (["node", "--import", "tsx", "tests/client-smoke.ts"], ROOT), (["node", "--import", "tsx", "tests/client-conformance.ts"], ROOT), (["go", "test", "-race", "-count=1", "./..."], ROOT / "clients/go"), (["cargo", "test", "--locked", "--quiet"], ROOT / "clients/rust")]
    failures = []
    for command, directory in commands:
        result = subprocess.run(command, cwd=directory, env=env, timeout=180)
        if result.returncode:
            failures.append(command)
    assert not failures, f"Client checks failed: {failures}"
    for attempt in range(50):
        request = Request(env["AGENTICDRIVER_TEST_REFERENCE_URL"] + "/metrics", headers={"Authorization": "Bearer " + token})
        with urlopen(request, context=ssl.create_default_context(cafile=ca), timeout=5) as response:
            metrics = json.load(response)
        if metrics["cancelled"] == 4:
            break
        time.sleep(0.02)
    assert metrics["cancelled"] == 4, metrics
    assert metrics["redirects"] == 0, metrics


with tempfile.TemporaryDirectory(prefix="agenticdriver-client-test-") as directory:
    cert, key = str(Path(directory) / "cert.pem"), str(Path(directory) / "key.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for secure in [False, True]:
        token = secrets.token_urlsafe(32)
        env = {key: value for key, value in os.environ.items() if not key.startswith("AGENTICDRIVER_")}
        env.update(AGENTICDRIVER_PROVIDER="mock", AGENTICDRIVER_PORT="0", AGENTICDRIVER_TOKEN=token)
        if secure:
            env.update(AGENTICDRIVER_TLS_CERT=cert, AGENTICDRIVER_TLS_KEY=key, NODE_EXTRA_CA_CERTS=cert)
        server = subprocess.Popen(["node", "--import", "tsx", "tests/conformance-host.ts"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
        try:
            hosts = json.loads(server.stdout.readline())
            url = hosts["url"]
            env.update(AGENTICDRIVER_TEST_URL=url, AGENTICDRIVER_TEST_TOKEN=token, AGENTICDRIVER_TEST_REFERENCE_URL=hosts["referenceUrl"])
            if secure:
                env["AGENTICDRIVER_TEST_CA"] = cert
            check_clients(url, token, cert if secure else None, env)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
print("All four language clients passed over HTTP and verified HTTPS.")
