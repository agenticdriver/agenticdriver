#!/usr/bin/env python3
"""Run the real Linux Codex binary against offline, synthetic SDK fixtures."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path,
                        help="Absolute path to the native Linux ELF binary, not its npm launcher")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Native Codex fixtures currently require Linux and bubblewrap.")
    if not args.binary.is_absolute() or not args.binary.is_file():
        parser.error("--binary must be an existing absolute native binary path.")
    binary = args.binary.resolve()
    code_mode_host = binary.with_name("codex-code-mode-host")
    if not code_mode_host.is_file():
        parser.error("Use the complete native installation, including its adjacent codex-code-mode-host executable.")
    with binary.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            parser.error("Pass the native ELF executable; npm launchers are not accepted.")
    bubblewrap, node = shutil.which("bwrap"), shutil.which("node")
    if not bubblewrap or not node:
        parser.error("Install bubblewrap and Node.js before running this fixture.")
    if not (ROOT / "dist/index.js").is_file():
        parser.error("Build the SDK first with npm run build.")
    # Preserve the real HOME value; hide its contents with a namespace mount.
    # No application, provider, proxy, loader, or credential environment is inherited.
    env = {key: os.environ[key] for key in
           ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL") if key in os.environ}
    env["TMPDIR"] = "/tmp"
    with tempfile.TemporaryDirectory(prefix="agenticdriver-codex-native-", dir="/tmp") as work:
        command = [bubblewrap, "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
                   "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
                   "--tmpfs", str(Path.home()), "--tmpfs", "/tmp",
                   "--bind", work, "/tmp/fixture-work",
                   "--ro-bind", str(ROOT), "/tmp/fixture-sdk",
                   "--ro-bind", str(binary), "/tmp/fixture-codex",
                   "--ro-bind", str(code_mode_host), "/tmp/codex-code-mode-host",
                   "--ro-bind", str(Path(node).resolve()), "/tmp/fixture-node",
                   "--chdir", "/tmp/fixture-work", "--", "/tmp/fixture-node",
                   "/tmp/fixture-sdk/scripts/fixtures/codex-native.mjs"]
        # This is a fixture watchdog, never an SDK run/inactivity default.
        try:
            completed = subprocess.run(command, env=env, capture_output=True, text=True,
                                       timeout=120, check=True)
        except subprocess.TimeoutExpired:
            raise SystemExit("The isolated native fixture exceeded its 120-second watchdog.")
        except subprocess.CalledProcessError as error:
            print(error.stdout, end="", file=sys.stderr)
            print(error.stderr, end="", file=sys.stderr)
            raise SystemExit("Native Codex fixture failed; no live account was used.")
        result = json.loads(completed.stdout)
    result.update({
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "binarySha256": digest(binary),
        "codeModeHostSha256": digest(code_mode_host),
        "adapterSha256": digest(ROOT / "dist/providers/codex-app-server.js"),
        "processRunnerSha256": digest(ROOT / "dist/providers/cli-process.js"),
        "classifierSha256": digest(ROOT / "dist/providers/codex-cli-errors.js"),
        "sourceCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceDirty": bool(subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
        "fixtureOnly": True,
        "externalNetwork": False,
        "realAccountUsed": False,
        "liveCertified": False,
    })
    encoded = json.dumps(result, indent=2) + "\n"
    if args.receipt:
        args.receipt.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
