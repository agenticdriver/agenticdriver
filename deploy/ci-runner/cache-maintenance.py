"""Bound rebuildable cache in AgenticDriver's private serial CI daemon only."""
import os
import shutil
import subprocess

PRIVATE_DAEMON = "tcp://127.0.0.1:2375"
MINIMUM_FREE = 8 * 1024 ** 3


def maintenance_command(env):
    required = {
        "GITHUB_REPOSITORY": "agenticdriver/agenticdriver",
        "GITHUB_REF": "refs/heads/sdk-roadmap",
        "RUNNER_NAME": "prometheus-agenticdriver-01",
        "DOCKER_HOST": PRIVATE_DAEMON,
    }
    if any(env.get(key) != value for key, value in required.items()):
        raise ValueError("Cache maintenance requires the dedicated AgenticDriver CI runner and private daemon")
    if env.get("GITHUB_EVENT_NAME") not in {"push", "workflow_dispatch"}:
        raise ValueError("Cache maintenance does not accept this workflow event")
    if any(env.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDX_BUILDER")):
        raise ValueError("Cache maintenance refuses an overridden Docker context or builder")
    # Explicit host and builder defeat accidental selection of a shared host
    # daemon or another buildx builder. Never remove containers/images/volumes.
    return ["docker", "--host", PRIVATE_DAEMON, "builder", "prune", "--builder", "default",
            "--force", "--reserved-space", "2GB", "--max-used-space", "8GB", "--min-free-space", "16GB"]


def maintain(env=None, run=subprocess.run, disk_usage=shutil.disk_usage):
    env = dict(os.environ if env is None else env)
    command = maintenance_command(env)
    run(command, check=True, capture_output=True, text=True, env=env)
    # /work is the shared CI volume, not the application or runner home.
    free = disk_usage("/work").free
    print(f"Private CI build-cache maintenance complete; {free / 1024 ** 3:.1f} GiB free on /work")
    if free < MINIMUM_FREE:
        raise ValueError("Less than 8 GiB remains after private cache cleanup; inspect storage before compiling")
    return free


if __name__ == "__main__":
    try:
        maintain()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        message = str(error) if isinstance(error, ValueError) else "Private CI cache maintenance failed; inspect the dedicated daemon"
        raise SystemExit(message) from None
