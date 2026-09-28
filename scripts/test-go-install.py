"""Install an exact public Go module version and compile the real quickstart.

This verifies registry installation only; it never starts a host or model request.
The subprocess watchdog bounds installation/build tooling, not SDK inference.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from release import ROOT, release_channel


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("version", help="Exact public module version, including v")
args = parser.parse_args()
release_channel(args.version, "go")
module = json.loads((ROOT / "release/config.json").read_text())["names"]["go"]

with tempfile.TemporaryDirectory(prefix="agenticdriver-go-install-") as directory:
    work = Path(directory)
    env = {**os.environ, "GOPROXY": "https://proxy.golang.org", "GONOPROXY": "none",
           "GOPRIVATE": "", "GOSUMDB": "sum.golang.org", "GONOSUMDB": "none",
           "GOWORK": "off", "GOFLAGS": "-mod=mod", "GIT_TERMINAL_PROMPT": "0",
           "GOPATH": str(work / "gopath"), "GOMODCACHE": str(work / "modules")}

    def go(*command):
        return subprocess.run(["go", *command], cwd=work, env=env, check=True,
                              text=True, stdout=subprocess.PIPE, timeout=300).stdout

    go("mod", "init", "example.test/agenticdriver-install-check")
    go("get", module + "@" + args.version)
    installed = json.loads(go("list", "-m", "-json", module))
    if (installed.get("Replace") or installed["Version"] != args.version
            or not Path(installed["Dir"]).is_relative_to(work / "modules")):
        raise ValueError("Expected the exact public module, without a local replacement")
    shutil.copyfile(ROOT / "examples/quickstart/client.go", work / "main.go")
    go("build", "-o", "client", ".")
    print(json.dumps({"module": module, "version": args.version,
                      "publicProxyInstalled": True, "quickstartCompiled": True,
                      "modelRequests": 0}))
