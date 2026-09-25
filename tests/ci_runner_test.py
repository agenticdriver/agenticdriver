"""The runner must reject untrusted events before any repository checkout."""
import json
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest

HOOK = Path(__file__).resolve().parents[1] / "deploy/ci-runner/job-started.py"


class RunnerBoundaryTests(unittest.TestCase):
    def invoke(self, policy=None, **overrides):
        env = {"GITHUB_REPOSITORY": "agenticdriver/agenticdriver", "GITHUB_REF": "refs/heads/sdk-roadmap",
               "GITHUB_EVENT_NAME": "push", **overrides}
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "job-started.py"
            script.write_bytes(HOOK.read_bytes())
            script.with_name("policy.json").write_text(json.dumps(policy if policy is not None else {
                "repository": "agenticdriver/agenticdriver", "ref": "refs/heads/sdk-roadmap"}))
            return subprocess.run([sys.executable, str(script)], env=env, capture_output=True).returncode

    def test_trusted_push_and_dispatch(self):
        for event in ("push", "workflow_dispatch"):
            self.assertEqual(self.invoke(GITHUB_EVENT_NAME=event), 0)

    def test_public_pr_events_never_reach_checkout(self):
        # Even a PR event that claims the trusted branch/repository must fail.
        for event in ("pull_request", "pull_request_target", "issue_comment", "workflow_run", ""):
            self.assertNotEqual(self.invoke(GITHUB_EVENT_NAME=event), 0)

    def test_repository_ref_and_configuration_are_required(self):
        for override in ({"GITHUB_REPOSITORY": "fork/agenticdriver"},
                         {"GITHUB_REF": "refs/heads/unreviewed"},
                         {"GITHUB_REPOSITORY": "fork/agenticdriver", "CI_REPOSITORY": "fork/agenticdriver"},
                         {"GITHUB_REF": "refs/heads/unreviewed", "CI_REF": "refs/heads/unreviewed"}):
            self.assertNotEqual(self.invoke(**override), 0)
        self.assertNotEqual(self.invoke(policy={}), 0)


if __name__ == "__main__":
    unittest.main()
