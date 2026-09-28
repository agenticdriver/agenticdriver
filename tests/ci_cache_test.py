"""Only the dedicated serial runner may prune its own rebuildable cache."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

path = Path(__file__).resolve().parents[1] / "deploy/ci-runner/cache-maintenance.py"
spec = importlib.util.spec_from_file_location("ci_cache", path)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
ENV = {"GITHUB_REPOSITORY": "agenticdriver/agenticdriver", "GITHUB_REF": "refs/heads/sdk-roadmap",
       "RUNNER_NAME": "prometheus-agenticdriver-01", "DOCKER_HOST": cache.PRIVATE_DAEMON,
       "GITHUB_EVENT_NAME": "push"}


class CacheBoundaryTests(unittest.TestCase):
    def test_only_private_daemon_build_cache_is_selected(self):
        run = Mock()
        usage = Mock(return_value=SimpleNamespace(free=16 * 1024 ** 3))
        self.assertEqual(cache.maintain(ENV, run, usage), 16 * 1024 ** 3)
        command = run.call_args.args[0]
        self.assertEqual(command[:7], ["docker", "--host", cache.PRIVATE_DAEMON, "builder", "prune", "--builder", "default"])
        self.assertEqual(command[7:], ["--force", "--reserved-space", "2GB", "--max-used-space", "8GB", "--min-free-space", "16GB"])
        usage.assert_called_once_with("/work")

    def test_foreign_runner_daemon_ref_and_event_cannot_run_docker(self):
        for override in [{"GITHUB_REPOSITORY": "other/app"}, {"GITHUB_REF": "refs/heads/other"},
                         {"RUNNER_NAME": "another-runner"}, {"DOCKER_HOST": "unix:///var/run/docker.sock"},
                         {"DOCKER_HOST": "tcp://remote:2375"}, {"GITHUB_EVENT_NAME": "pull_request"},
                         {"GITHUB_EVENT_NAME": "pull_request_target"}, {"DOCKER_CONTEXT": "shared"},
                         {"BUILDX_BUILDER": "remote-builder"}, {"DOCKER_CERT_PATH": "/remote"},
                         {"DOCKER_TLS_VERIFY": "1"}]:
            with self.subTest(override=override):
                run = Mock()
                with self.assertRaises(ValueError):
                    cache.maintain({**ENV, **override}, run)
                run.assert_not_called()

    def test_absent_environment_is_not_authorization(self):
        with self.assertRaises(ValueError):
            cache.maintenance_command({})
        self.assertEqual(cache.maintenance_command({**ENV, "GITHUB_EVENT_NAME": "workflow_dispatch"}), cache.maintenance_command(ENV))

    def test_low_storage_is_reported_without_broader_cleanup(self):
        run = Mock()
        with self.assertRaisesRegex(ValueError, "Less than 8 GiB"):
            cache.maintain(ENV, run, lambda _: SimpleNamespace(free=cache.MINIMUM_FREE - 1))
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
