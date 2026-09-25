#!/usr/bin/env python3
"""Runner-owned gate runs before checkout; public PRs never execute here."""
import json
import os
from pathlib import Path
import sys

policy = json.loads(Path(__file__).with_name("policy.json").read_text())
allowed = (
    os.environ.get("GITHUB_REPOSITORY") == policy.get("repository")
    and bool(policy.get("repository"))
    and os.environ.get("GITHUB_REF") == policy.get("ref")
    and bool(policy.get("ref"))
    and os.environ.get("GITHUB_EVENT_NAME") in {"push", "workflow_dispatch"}
)
if not allowed:
    print("Prometheus runner accepts only its configured repository/branch and push or manual events.", file=sys.stderr)
    sys.exit(1)
print("Prometheus trusted-source gate passed.")
