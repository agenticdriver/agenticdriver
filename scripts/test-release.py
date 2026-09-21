"""Install reviewed packages into fresh applications and run the docs.

By default, use candidate archives. --registry selects already published
channels, whose remote contents must match the candidate before installation.
No registry upload, real account, provider API or sibling checkout is used.
Infrastructure watchdogs below do not change SDK run/inactivity defaults.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile

from release import ROOT, verify
from publish import check_registry
from tls_fixture import create_tls_fixture


def run(args, cwd, env):
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, text=True,
                          check=True, capture_output=True, timeout=300)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("candidate", type=Path)
parser.add_argument("--registry", action="append", default=[],
                    choices=["npm", "python", "rust", "go"],
                    help="Install this exact published version instead of its local archive; repeatable")
args = parser.parse_args()
candidate = args.candidate.resolve()
manifest = verify(candidate)
packages = manifest["packages"]
registries = set(args.registry)
for registry in sorted(registries):
    check_registry(candidate, registry)
# Do not inherit an application/provider account or custom module search path.
env = {key: value for key, value in os.environ.items()
       if not key.startswith("AGENTICDRIVER_") and key not in {"PYTHONPATH", "PYTHONHOME"}}
with tempfile.TemporaryDirectory(prefix="agenticdriver-release-test-") as directory:
    work = Path(directory)
    javascript = work / "javascript"
    javascript.mkdir()
    (javascript / "package.json").write_text('{"private":true,"type":"module"}')
    npm_package = (packages["npm"]["name"] + "@" + packages["npm"]["version"]
                   if "npm" in registries else candidate / packages["npm"]["archive"])
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund",
         "--registry=https://registry.npmjs.org", "--cache=" + str(work / "npm-cache"),
         npm_package], javascript, env)
    installed = javascript / "node_modules/@agenticdriver/sdk"
    installed_metadata = json.loads((installed / "package.json").read_text())
    assert installed_metadata["name"] == packages["npm"]["name"]
    assert installed_metadata["version"] == packages["npm"]["version"]
    if "npm" in registries:
        lock = json.loads((javascript / "package-lock.json").read_text())
        dependency = lock["packages"]["node_modules/@agenticdriver/sdk"]
        assert dependency["resolved"].startswith("https://registry.npmjs.org/")
    for name in ["brandstorm", "literature-review", "email-workspace"]:
        shutil.copyfile(installed / f"examples/javascript/{name}.mts", javascript / f"{name}.mts")
        result = run(["node", "--experimental-strip-types", f"{name}.mts"], javascript, env)
        assert result.stdout.strip()
    shutil.copyfile(installed / "examples/quickstart/client.mjs", javascript / "client.mjs")
    (javascript / "host.mjs").write_text('''
import { readFile } from 'node:fs/promises';
import { AgenticDriver } from '@agenticdriver/sdk';
import { mockProvider } from '@agenticdriver/sdk/providers';
import { serve } from '@agenticdriver/sdk/server';
const host = await serve(new AgenticDriver({providers:[mockProvider()]}), {
  port: 0,
  tokens: [{token: process.env.FIXTURE_TOKEN, subject:'fixture', providers:['mock']}],
  tls: {cert: await readFile(process.env.FIXTURE_CERT), key: await readFile(process.env.FIXTURE_KEY)},
});
console.log(JSON.stringify({url: host.url}));
process.on('SIGTERM', () => { void host.close().then(() => process.exit(0)); });
''')
    applications = [(["node", "client.mjs"], javascript)]
    for kind in ["wheel", "sdist"]:
        application = work / ("python-" + kind)
        application.mkdir()
        run([sys.executable, "-m", "venv", ".venv"], application, env)
        executable = application / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python_package = (packages["python"]["name"] + "==" + packages["python"]["version"]
                          if "python" in registries else candidate / packages["python"][kind])
        install_options = (["--index-url", "https://pypi.org/simple", "--no-cache-dir",
                            "--only-binary=agenticdriver" if kind == "wheel" else "--no-binary=agenticdriver"]
                           if "python" in registries else [])
        run([executable, "-m", "pip", "install", "--quiet", *install_options, python_package], application, env)
        shutil.copyfile(installed / "examples/quickstart/client.py", application / "client.py")
        applications.append(([executable, "client.py"], application))
    go = work / "go"
    go.mkdir()
    module = packages["go"]["name"]
    go_env = {**env, "GOPROXY": "https://proxy.golang.org" if "go" in registries else (candidate / "go").as_uri(),
              "GONOPROXY": "none", "GOPRIVATE": "", "GOSUMDB": "sum.golang.org",
              "GONOSUMDB": "none" if "go" in registries else module, "GOWORK": "off", "GOFLAGS": "-mod=mod",
              "GOPATH": str(work / "gopath"), "GOMODCACHE": str(work / "modules"),
              "GIT_TERMINAL_PROMPT": "0"}
    run(["go", "mod", "init", "example.test/release-client"], go, go_env)
    run(["go", "get", module + "@" + packages["go"]["version"]], go, go_env)
    metadata = json.loads(run(["go", "list", "-m", "-json", module], go, go_env).stdout)
    assert not metadata.get("Replace") and Path(metadata["Dir"]).is_relative_to(work / "modules")
    shutil.copyfile(installed / "examples/quickstart/client.go", go / "main.go")
    run(["go", "build", "-o", "client", "."], go, go_env)
    applications.append(([go / "client"], go))
    rust = work / "rust"
    (rust / "src").mkdir(parents=True)
    vendor = rust / "vendor"
    vendor.mkdir()
    with tarfile.open(candidate / packages["rust"]["archive"], "r:gz") as bundle:
        # verify() rejected all links, traversal, duplicates and oversized members.
        bundle.extractall(vendor, filter="data")
    package = f'{packages["rust"]["name"]}-{packages["rust"]["version"]}'
    rust_dependency = ('"=' + packages["rust"]["version"] + '"' if "rust" in registries
                       else '{ path = "vendor/' + package + '" }')
    (rust / "Cargo.toml").write_text(f'''[package]
name = "release-client"
version = "0.0.0"
edition = "2021"
[dependencies]
agenticdriver = {rust_dependency}
''')
    shutil.copyfile(vendor / package / "Cargo.lock", rust / "Cargo.lock")
    shutil.copyfile(installed / "examples/quickstart/client.rs", rust / "src/main.rs")
    rust_env = {**env, "CARGO_TARGET_DIR": str(ROOT / "clients/rust/target")}
    run(["cargo", "+1.89.0", "build"], rust, rust_env)
    if "rust" in registries:
        metadata = json.loads(run(["cargo", "+1.89.0", "metadata", "--locked", "--format-version=1"], rust, rust_env).stdout)
        sdk = next(package for package in metadata["packages"] if package["name"] == "agenticdriver")
        assert sdk["version"] == packages["rust"]["version"]
        assert sdk["source"] == "registry+https://github.com/rust-lang/crates.io-index"
    applications.append((["cargo", "+1.89.0", "run", "--locked", "--quiet"], rust))
    ca, cert, key = create_tls_fixture(work)
    token = secrets.token_urlsafe(32)
    token_file = work / "token"
    token_file.write_text(token)
    token_file.chmod(0o600)
    host = subprocess.Popen(["node", "host.mjs"], cwd=javascript,
                            env={**env, "FIXTURE_TOKEN": token, "FIXTURE_CERT": cert, "FIXTURE_KEY": key},
                            text=True, stdout=subprocess.PIPE, stderr=sys.stderr)
    try:
        url = json.loads(host.stdout.readline())["url"]
        client_env = {**rust_env, "AGENTICDRIVER_URL": url,
                      "AGENTICDRIVER_TOKEN_FILE": str(token_file), "AGENTICDRIVER_PROVIDER": "mock",
                      "AGENTICDRIVER_MODEL": "demo", "AGENTICDRIVER_CA": ca, "NODE_EXTRA_CA_CERTS": ca}
        for command, application in applications:
            result = run(command, application, client_env)
            assert result.stdout.strip() == "AgenticDriver is connected.", application.name
            print("Reviewed package quickstart passed over verified HTTPS: " + application.name, flush=True)
    finally:
        host.terminate()
        try:
            host.wait(timeout=10)
        except subprocess.TimeoutExpired:
            host.kill()
            host.wait()
print("npm, Python wheel+sdist, Go module and Rust crate passed; registry installs: "
      + (", ".join(sorted(registries)) or "none (candidate archives)") + ". No upload performed.")
