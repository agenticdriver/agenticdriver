#!/usr/bin/env python3
"""Qualify native Claude contracts using synthetic credentials and no external network."""
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
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--suite", choices=["catalog", "adapter"], default="catalog")
    args = parser.parse_args()
    binary = args.binary.resolve()
    node, bubblewrap = shutil.which("node"), shutil.which("bwrap")
    if sys.platform != "linux" or not node or not bubblewrap:
        parser.error("This native fixture requires Linux, Node.js and bubblewrap.")
    if not binary.is_file() or not args.binary.is_absolute():
        parser.error("Supply the installed native Claude binary's absolute path.")
    with binary.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            parser.error("The native Linux ELF executable is required.")
    env = {key: os.environ[key] for key in
           ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL") if key in os.environ}
    with tempfile.TemporaryDirectory(prefix="agenticdriver-claude-native-") as scratch:
        command = [bubblewrap, "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
                   "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
                   "--tmpfs", str(Path.home()), "--tmpfs", "/tmp", "--tmpfs", "/etc",
                   "--dir", "/etc/claude-code", "--bind", scratch, "/tmp/fixture-work",
                   "--ro-bind", str(ROOT), "/tmp/fixture-sdk",
                   "--ro-bind", str(binary), "/tmp/fixture-claude",
                   "--ro-bind", str(Path(node).resolve()), "/tmp/fixture-node",
                   "--chdir", "/tmp/fixture-work", "--", "/tmp/fixture-node",
                   f"/tmp/fixture-sdk/scripts/fixtures/claude-{args.suite}-native.mjs"]
        # Bounds offline fixture housekeeping only; no external inference is submitted.
        completed = subprocess.run(command, env=env, text=True, capture_output=True, timeout=90)
        if completed.returncode:
            print(completed.stdout, end="", file=sys.stderr)
            print(completed.stderr, end="", file=sys.stderr)
            raise SystemExit("Native fixture failed; no real account was used.")
        result = json.loads(completed.stdout)
    # The explicit CI mount may have another UID. Limit Git's trust exception to
    # this checkout and these read-only provenance commands; do not change config.
    result.update({
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "sourceCommit": subprocess.check_output(
            ["git", "-c", f"safe.directory={ROOT}", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceDirty": bool(subprocess.check_output(
            ["git", "-c", f"safe.directory={ROOT}", "status", "--porcelain"], cwd=ROOT)),
        "suite": args.suite,
        "adapterSha256": hashlib.sha256((ROOT / "dist/providers/local-cli.js").read_bytes()).hexdigest(),
    })
    if args.receipt:
        args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
