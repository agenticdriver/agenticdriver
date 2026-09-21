"""Disposable Linux containers: native Better Auth/AuthYard, TLS proxy and installed clients.

All credentials/accounts in this harness are synthetic. Test timeouts bound checks,
not SDK runs. No image is pushed and only this unique Compose project is removed.
"""
import datetime
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import zipfile
from python_package import prepare_python
from rust_package import prepare_rust, TOOLCHAIN
from tls_fixture import create_tls_fixture

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "tests/deployment"
QUICKSTARTS = ROOT / "examples/quickstart"
IMAGE = os.environ.get("AGENTICDRIVER_TEST_IMAGE", "agenticdriver:deployment-test")
AUTH_IMAGE = IMAGE + "-auth"
PROXY_IMAGE = IMAGE + "-proxy"
MODULE = "github.com/agenticdriver/agenticdriver/clients/go"


def run(command, *, cwd=ROOT, env=None, timeout=300, capture=False, check=True):
    return subprocess.run(command, cwd=cwd, env=env, check=check, timeout=timeout,
                          text=True, capture_output=capture)


def clients(work):
    # Build before minting the short-lived service credential.
    python, py_app = prepare_python(work)
    shutil.copyfile(SOURCES / "client.py", py_app / "app.py")
    shutil.copyfile(QUICKSTARTS / "client.py", py_app / "quickstart.py")
    rust_app, rust_env = prepare_rust(work)
    shutil.copyfile(SOURCES / "client.rs", rust_app / "src/main.rs")
    (rust_app / "src/bin").mkdir()
    shutil.copyfile(QUICKSTARTS / "client.rs", rust_app / "src/bin/quickstart.rs")
    run(["cargo", f"+{TOOLCHAIN}", "build", "--locked"], cwd=rust_app,
        env={**os.environ, **rust_env})
    js_app = work / "javascript-application"
    js_app.mkdir()
    run(["npm", "pack", "--pack-destination", str(js_app)], capture=True)
    (archive,) = js_app.glob("agenticdriver-*.tgz")
    (js_app / "package.json").write_text('{"private":true,"type":"module"}')
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", str(archive)], cwd=js_app)
    shutil.copyfile(SOURCES / "client.mjs", js_app / "client.mjs")
    shutil.copyfile(QUICKSTARTS / "client.mjs", js_app / "quickstart.mjs")
    # Install a real module archive with no source-relative replace directive.
    go_app = work / "go-application"
    go_app.mkdir()
    proxy = work / "go-proxy"
    version = "v0.0.0-ci"
    versions = proxy / MODULE / "@v"
    versions.mkdir(parents=True)
    (versions / "list").write_text(version + "\n")
    (versions / (version + ".mod")).write_bytes((ROOT / "clients/go/go.mod").read_bytes())
    (versions / (version + ".info")).write_text(json.dumps({"Version": version, "Time": datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    with zipfile.ZipFile(versions / (version + ".zip"), "w", zipfile.ZIP_DEFLATED) as archive:
        for path in (ROOT / "clients/go").rglob("*"):
            relative = path.relative_to(ROOT / "clients/go")
            if path.is_file() and not any(part.startswith(".") for part in relative.parts):
                archive.write(path, MODULE + "@" + version + "/" + relative.as_posix())
    go_env = {**os.environ, "GOWORK": "off", "GOFLAGS": "-mod=mod",
              "GOPATH": str(work / "go-path"), "GOMODCACHE": str(work / "go-modules"),
              "GOPROXY": proxy.as_uri(), "GONOPROXY": "none", "GONOSUMDB": MODULE}
    run(["go", "mod", "init", "example.test/deployment"], cwd=go_app, env=go_env)
    run(["go", "get", MODULE + "@" + version], cwd=go_app, env=go_env)
    assert "replace" not in (go_app / "go.mod").read_text()
    shutil.copyfile(SOURCES / "client.go", go_app / "main.go")
    run(["go", "build", "-o", "client", "."], cwd=go_app, env=go_env)
    shutil.copyfile(QUICKSTARTS / "client.go", go_app / "main.go")
    run(["go", "build", "-o", "quickstart", "."], cwd=go_app, env=go_env)
    return [(["node", "client.mjs"], js_app, {}), ([python, "app.py"], py_app, {}),
            ([str(go_app / "client")], go_app, go_env),
            (["cargo", f"+{TOOLCHAIN}", "run", "--locked", "--quiet", "--bin", "agenticdriver-installed-app"], rust_app, rust_env),
            (["node", "quickstart.mjs"], js_app, {}), ([python, "quickstart.py"], py_app, {}),
            ([str(go_app / "quickstart")], go_app, go_env),
            (["cargo", f"+{TOOLCHAIN}", "run", "--locked", "--quiet", "--bin", "quickstart"], rust_app, rust_env)]


if "--skip-build" not in sys.argv:
    run(["docker", "build", "-t", IMAGE, "."], timeout=900)
    run(["docker", "build", "-f", "Dockerfile.proxy", "-t", PROXY_IMAGE, "."], cwd=ROOT / "deploy")
    run(["docker", "build", "--build-arg", "AGENTICDRIVER_IMAGE=" + IMAGE,
         "-f", "Dockerfile.deployment", "-t", AUTH_IMAGE, "."],
        cwd=ROOT / "integrations/better-auth", timeout=600)

with tempfile.TemporaryDirectory(prefix="agenticdriver-deployment-") as directory:
    work = Path(directory)
    commands = [] if "--transport-only" in sys.argv else clients(work)
    tls = work / "runtime/tls"
    config_dir = work / "runtime/config"
    secrets_dir = work / "runtime/secrets"
    output = work / "output"
    for folder in [tls, config_dir, secrets_dir, output]:
        folder.mkdir(parents=True)
    # Cross-UID CI writers share synthetic files below the private temp parent.
    # Production instructions instead give these directories to container UID 1000.
    for folder in [config_dir, secrets_dir, output]:
        folder.chmod(0o777)
    ca, cert, key = create_tls_fixture(work)
    for source, name in [(ca, "ca.crt"), (cert, "server.crt"), (key, "server.key")]:
        shutil.copyfile(source, tls / name)
        (tls / name).chmod(0o444)
    shutil.copyfile(ROOT / "deploy/Caddyfile", work / "Caddyfile")
    shutil.copyfile(ROOT / "deploy/compose.yaml", work / "compose.yaml")
    config = {
        "version": 1, "listen": {"host": "127.0.0.1", "port": 7433},
        "providers": [{"kind": "openai", "id": "fixture", "models": ["fixture-model"],
                       "accountId": "synthetic-deployment-account",
                       "baseUrl": "http://127.0.0.1:7452/v1/",
                       "apiKeyRef": {"file": "/run/secrets/provider-key"}}],
        "usage": {"hostId": "synthetic-deployment-host"},
        "operations": {"directory": "/var/lib/agenticdriver/operations"},
        "usageLog": "/var/lib/agenticdriver/usage.jsonl",
        "concurrency": {"total": 1, "perSubject": 1},
    }
    (config_dir / "config.json").write_text(json.dumps(config))
    (config_dir / "config.json").chmod(0o444)
    override = {"services": {
        "fixture": {
            "image": AUTH_IMAGE, "user": "1000:1000", "init": True,
            "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "network_mode": "service:proxy", "depends_on": {"proxy": {"condition": "service_started"}},
            "environment": {"NODE_EXTRA_CA_CERTS": "/run/tls/ca.crt"},
            "volumes": ["./runtime/tls:/run/tls:ro", "./runtime/config:/fixture-config",
                        "./runtime/secrets:/fixture-secrets", "./output:/fixture-output"],
            "tmpfs": ["/tmp:uid=1000,gid=1000,mode=0700"],
            "stop_grace_period": "10s",
        },
        "driver": {
            "depends_on": {"fixture": {"condition": "service_healthy"}},
            "environment": {"NODE_EXTRA_CA_CERTS": "/run/tls/ca.crt"},
            "volumes": ["./runtime/tls:/run/tls:ro"],
        },
    }}
    (work / "fixture.json").write_text(json.dumps(override))
    project = "agenticdriver-deployment-" + secrets.token_hex(5)
    env = {**os.environ, "AGENTICDRIVER_IMAGE": IMAGE, "AGENTICDRIVER_PROXY_IMAGE": PROXY_IMAGE, "AGENTICDRIVER_BIND_ADDRESS": "127.0.0.1",
           "AGENTICDRIVER_HTTPS_PORT": "0"}
    base = ["docker", "compose", "-p", project, "-f", str(work / "compose.yaml"),
            "-f", str(work / "fixture.json")]

    def compose(*args, **options):
        return run([*base, *args], cwd=work, env=env, **options)

    def fixture_json(path):
        # Capture private fixture files without echoing tokens to CI logs.
        source = "process.stdout.write(require('fs').readFileSync(" + json.dumps(path) + ", 'utf8'))"
        return json.loads(compose("exec", "-T", "fixture", "node", "-e", source, capture=True).stdout)

    def metrics():
        return fixture_json("/fixture-output/metrics.json")

    def wait_metric(name, expected):
        for _ in range(50):
            result = metrics()
            if result[name] == expected:
                return
            time.sleep(0.1)
        raise AssertionError((name, expected, result))

    try:
        compose("config", "--quiet")
        compose("up", "--wait", "--wait-timeout", "90", "--no-build", timeout=180)
        port = int(compose("port", "proxy", "8443", capture=True).stdout.strip().rsplit(":", 1)[1])
        credential = fixture_json("/fixture-output/credential.json")["token"]
        context = ssl.create_default_context(cafile=ca)

        def request(path, data=None, *, authenticated=True, headers=None):
            connection = http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=10)
            head = {"Content-Type": "application/json", **(headers or {})}
            if authenticated:
                head["Authorization"] = "Bearer " + credential
            connection.request("GET" if data is None else "POST", path,
                               None if data is None else json.dumps(data), head)
            return connection, connection.getresponse()

        connection, response = request("/health", authenticated=False)
        assert response.status == 200
        assert response.getheader("Strict-Transport-Security") == "max-age=31536000"
        assert response.getheader("X-Content-Type-Options") == "nosniff"
        assert response.getheader("Cache-Control") == "no-store"
        assert response.getheader("AgenticDriver-Version") == "1.0"
        assert response.getheader("Server") is None
        response.read(); connection.close()
        for path, authenticated, headers, status in [
            ("/v1/providers", False, {}, 401),
            ("/v1/providers", True, {"Origin": "https://unrelated.example"}, 403),
        ]:
            connection, response = request(path, authenticated=authenticated, headers=headers)
            assert response.status == status, (response.status, response.read())
            response.read(); connection.close()
        untrusted = http.client.HTTPSConnection("127.0.0.1", port, timeout=5)
        try:
            untrusted.request("GET", "/health")
        except ssl.SSLCertVerificationError:
            pass
        else:
            raise AssertionError("Untrusted certificate was accepted")
        finally:
            untrusted.close()
        for service in ["driver", "fixture"]:
            container = compose("ps", "-q", service, capture=True).stdout.strip()
            inspection = json.loads(run(["docker", "inspect", container], capture=True).stdout)[0]
            assert inspection["Config"]["User"] == "1000:1000"
            assert inspection["HostConfig"]["ReadonlyRootfs"]
            assert not inspection["HostConfig"]["PortBindings"]
            assert inspection["HostConfig"]["NetworkMode"].startswith("container:")
        client_env = {key: value for key, value in os.environ.items()
                      if key not in {"PYTHONHOME", "PYTHONPATH"} and not key.startswith("AGENTICDRIVER_")}
        client_env.update(AGENTICDRIVER_TEST_URL=f"https://127.0.0.1:{port}",
                          AGENTICDRIVER_TEST_TOKEN=credential, AGENTICDRIVER_TEST_CA=ca,
                          NODE_EXTRA_CA_CERTS=ca)
        credential_file = work / "client-token"
        credential_file.write_text(credential)
        credential_file.chmod(0o600)
        client_env.update(AGENTICDRIVER_URL=f"https://127.0.0.1:{port}",
                          AGENTICDRIVER_TOKEN_FILE=str(credential_file),
                          AGENTICDRIVER_PROVIDER="fixture", AGENTICDRIVER_MODEL="fixture-model",
                          AGENTICDRIVER_CA=ca)
        for command, application, extra in commands:
            completed = run(command, cwd=application, env={**extra, **client_env}, timeout=90, capture=True)
            if any("quickstart" in part for part in command):
                assert completed.stdout.strip() == "Remote deployment works.", command
                print("Documented quickstart passed with the installed package: " + application.name, flush=True)
            else:
                print(completed.stdout.strip(), flush=True)
        baseline = metrics()
        hold = {"provider": "fixture", "model": "fixture-model", "input": "hold-until-cancel"}

        def open_stream():
            connection, response = request("/v1/runs", hold, headers={"Accept": "text/event-stream"})
            assert response.status == 200, (response.status, response.read())
            assert response.getheader("Content-Type").startswith("text/event-stream")
            assert response.getheader("Content-Encoding") is None
            # An unfinished upstream sends text before completion: buffering would time out.
            while True:
                line = response.readline()
                assert line, "Stream ended before model progress"
                if line.startswith(b"data:"):
                    event = json.loads(line[5:])
                    if event["type"] == "text.delta":
                        assert event["text"] == "Remote "
                        return connection, response

        connection, response = open_stream()
        second, rejected = request("/v1/runs", {**hold, "input": "capacity"})
        assert rejected.status == 429, (rejected.status, rejected.read())
        assert json.load(rejected)["error"]["code"] == "BUSY"
        second.close()
        response.close(); connection.close()
        wait_metric("cancelled", baseline["cancelled"] + 1)
        assert metrics()["requests"] == baseline["requests"] + 1
        # Persisted idempotency survives a driver process restart, without retrying model work.
        keyed = {"provider": "fixture", "model": "fixture-model", "input": "restart check", "idempotencyKey": "deployment-restart"}
        connection, response = request("/v1/runs", keyed)
        assert response.status == 200, (response.status, response.read())
        accepted = json.load(response); connection.close()
        connection, response = open_stream()
        compose("stop", "driver", timeout=45)
        response.close(); connection.close()
        wait_metric("cancelled", baseline["cancelled"] + 2)
        container = compose("ps", "--all", "-q", "driver", capture=True).stdout.strip()
        state = json.loads(run(["docker", "inspect", container], capture=True).stdout)[0]["State"]
        assert state["ExitCode"] == 0 and not state["OOMKilled"], state
        compose("up", "--wait", "--wait-timeout", "60", "--no-build", "driver", timeout=90)
        before = metrics()["requests"]
        connection, response = request("/v1/runs", keyed)
        assert response.status == 200, (response.status, response.read())
        assert json.load(response) == accepted
        connection.close()
        assert metrics()["requests"] == before
        # A replacement proxy gets a new network namespace. Recreate dependents
        # together; the synthetic auth peer also lives in that namespace.
        compose("stop", "driver", "fixture", timeout=45)
        compose("up", "--wait", "--wait-timeout", "90", "--no-build", "--force-recreate",
                "proxy", "fixture", "driver", timeout=150)
        port = int(compose("port", "proxy", "8443", capture=True).stdout.strip().rsplit(":", 1)[1])
        credential = fixture_json("/fixture-output/credential.json")["token"]
        connection, response = request("/v1/runs", keyed)
        assert response.status == 200, (response.status, response.read())
        assert json.load(response) == accepted
        connection.close()
        before = metrics()["requests"]
        assert before == 0
        # Removing app-owned authorization takes effect on the next request.
        compose("exec", "-T", "fixture", "node", "-e",
                "const f=require('fs'),p='/fixture-config/authorization.json',v=JSON.parse(f.readFileSync(p));v.services[0].scopes=[];f.writeFileSync(p+'.tmp',JSON.stringify(v),{mode:0o600});f.renameSync(p+'.tmp',p)", capture=True)
        connection, response = request("/v1/runs", {**keyed, "idempotencyKey": "revoked"})
        assert response.status == 401, (response.status, response.read())
        response.read(); connection.close()
        assert metrics()["requests"] == before
        logs = compose("logs", "--no-color", capture=True).stdout
        secret_value = compose("exec", "-T", "fixture", "node", "-e", "process.stdout.write(require('fs').readFileSync('/fixture-secrets/oauth-introspection-secret','utf8'))", capture=True).stdout
        assert all(value not in logs for value in [credential, secret_value, "synthetic-deployment-model-key"])
        print("Container checks passed: verified TLS, headers, auth, streaming, cancellation, capacity, graceful shutdown, durable replay and revocation.", flush=True)
    except BaseException:
        # Only synthetic fixture logs; auth logger and provider payload logging are disabled.
        compose("logs", "--no-color", "--tail", "35", check=False)
        raise
    finally:
        compose("down", "--volumes", "--remove-orphans", timeout=90)
print("Installed clients and a fresh self-hosted deployment passed." if commands else "Transport-only development check passed.", flush=True)
