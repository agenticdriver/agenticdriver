#!/usr/bin/env python3
"""Reproduce Gemini's ACP inventory and missing-login limitation without a real account."""
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    package = args.package.resolve()
    node, bubblewrap = shutil.which("node"), shutil.which("bwrap")
    if sys.platform != "linux" or not node or not bubblewrap:
        parser.error("This native fixture requires Linux, Node.js and bubblewrap.")
    if not args.package.is_absolute() or not (package / "bundle/gemini.js").is_file():
        parser.error("Supply the installed @google/gemini-cli package's absolute directory.")
    metadata = json.loads((package / "package.json").read_text())
    if metadata.get("name") != "@google/gemini-cli" or metadata.get("version") != "0.58.0":
        parser.error("This qualification fixture is pinned to Gemini CLI 0.58.0.")
    env = {key: os.environ[key] for key in
           ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL") if key in os.environ}
    with tempfile.TemporaryDirectory(prefix="agenticdriver-gemini-native-") as scratch:
        command = [bubblewrap, "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
                   "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
                   "--tmpfs", str(Path.home()), "--tmpfs", "/tmp", "--tmpfs", "/etc",
                   "--bind", scratch, "/tmp/fixture-work",
                   "--ro-bind", str(ROOT), "/tmp/fixture-sdk",
                   "--ro-bind", str(package), "/tmp/fixture-gemini",
                   "--ro-bind", str(Path(node).resolve()), "/tmp/fixture-node",
                   "--chdir", "/tmp/fixture-work", "--", "/tmp/fixture-node",
                   "/tmp/fixture-sdk/scripts/fixtures/gemini-catalog-native.mjs"]
        completed = subprocess.run(command, env=env, text=True, capture_output=True, timeout=45)
        if completed.returncode:
            # Native auth URLs and terminal diagnostics are deliberately not exported.
            raise SystemExit("Gemini metadata fixture failed; inspect the isolated protocol contract.")
        result = json.loads(completed.stdout)
    source_hash = hashlib.sha256()
    bundle_files = sorted((package / "bundle").glob("*.js"))
    for path in bundle_files:
        source_hash.update(path.name.encode() + b"\0")
        source_hash.update(hashlib.sha256(path.read_bytes()).digest())
    result.update({
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "bundleJavaScriptSha256": source_hash.hexdigest(),
        "bundleJavaScriptFiles": len(bundle_files),
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
    })
    if args.receipt:
        args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
