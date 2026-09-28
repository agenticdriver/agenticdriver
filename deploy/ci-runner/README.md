# Prometheus CI runner

AgenticDriver uses a repository-scoped Linux x64 GitHub Actions runner on
Prometheus. GitHub schedules jobs and retains logs/artifacts; Prometheus supplies
compute. The labels are `self-hosted`, `linux`, `x64`, `prometheus-ci`. There is no
hosted-runner fallback. The stack lives at `/var/docker/agenticdriver-ci`.

The CI workflow schedules one job group at a time: desktop, Codex, Claude,
deployment, the three runtime combinations, documentation and release candidate.
The runtime matrix has `max-parallel: 1`. This matches the single runner instead
of leaving nine jobs waiting for assignment. In run `36323616397`, eight checks
passed, but GitHub cancelled the last unassigned job after about twenty minutes
with “The job was not acquired by Runner of type self-hosted even after multiple
attempts.” The runner remained online and the private Docker daemon was healthy.

Group dependencies use `!cancelled()` so a completed test failure does not hide
later diagnostics, while cancelling an obsolete workflow still stops its queue.
All nine checks and the repository/ref guards remain in place. See
[GitHub's job conditions](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)
and [matrix limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymax-parallel).

The Ubuntu 24.04 userspace contains compiler, Git/GitHub CLI, Python bootstrap,
OpenSSL, Poppler and Docker CLI prerequisites. Workflows install their declared
Node, Python, Go and Rust versions. Runner 2.337.0 is downloaded from the official
release with its SHA-256 checked; its normal updater remains enabled. The Fedora
host kernel remains in use, so this is not the former GitHub Ubuntu VM image.

## Execution boundary

Only pushes to `sdk-roadmap` and manual dispatches on that branch are accepted.
There is no PR workflow trigger. GitHub requires approval for all external
contributors' fork workflows; do not approve those jobs onto this runner.
The root-owned `job-started.py` also rejects PR events, other repositories and
other refs before checkout using root-owned `policy.json`. Workflow environment
variables cannot replace that policy. The runner user cannot edit either file.

The runner is persistent and handles trusted repository code only. It is not an
isolation service for arbitrary pull requests. GitHub recommends ephemeral
runners for autoscaling; this small serial runner does not implement autoscaling.
See [GitHub's runner guidance](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

Container tests use a separate Docker-in-Docker daemon. It listens only on the
stack's loopback namespace and publishes no host ports. The runner shares that
network namespace for its build processes. Only CI work/temp volumes are
shared for container bind mounts. Prometheus's Docker socket, SSH keys, provider
sessions and deployment credentials are not mounted. The Docker daemon container
is privileged; this configuration is therefore not a hostile-code sandbox.
Runner memory is capped at 8 GiB, nested Docker at 4 GiB. Existing homelab services
are outside this Compose project.

## Storage maintenance

Each serial CI job runs `cache-maintenance.py` after checkout and before builds.
It selects only the private loopback Docker daemon and its default builder. The
helper rejects other repositories, refs, runners, events and Docker contexts;
the root-owned job-started policy remains the authorization boundary.

The [BuildKit cache limits](https://docs.docker.com/reference/cli/docker/buildx/prune/)
retain up to 8 GB of unused build cache, reserve 2 GB for reuse, and target 16 GB
of free space. These are cleanup targets, not a filesystem quota: layers used
by images and active builds cannot necessarily be reclaimed. The helper checks
the shared work filesystem after pruning and refuses to start compiling below
8 GiB free. It never prunes containers, images, volumes, the host Docker daemon,
application data, runner registration or provider credentials. Other projects
can still fill the shared host filesystem; investigate that separately instead
of expanding this cleanup's scope.

For manual recovery, first verify the repository runner is idle and no SDK job
is running. Stop its listener to prevent a new job racing maintenance, preserving
its registration and volumes:

```sh
gh api repos/agenticdriver/agenticdriver/actions/runners \
  --jq '.runners[] | {name,status,busy}'
ssh prometheus 'cd /var/docker/agenticdriver-ci && docker compose stop runner'
ssh prometheus 'docker exec agenticdriver-ci-docker-1 docker builder prune --builder default --force --reserved-space 2GB --max-used-space 8GB --min-free-space 16GB'
ssh prometheus 'df -h /'
ssh prometheus 'cd /var/docker/agenticdriver-ci && docker compose up -d runner'
```

The manual command executes inside this project's private daemon container, not
on the host daemon. Resume the listener even if cleanup cannot recover enough
space, then inspect storage before dispatching another build. Do not use host
`docker system prune` or delete shared Docker volumes as a shortcut.

Run `36354619085` failed during Rust linking when the host filesystem filled;
its earlier successful jobs do not make that workflow green. Private build-cache
recovery restored capacity without changing the published alpha.4 artifacts.
The subsequent CI run is the evidence for the maintenance change, rather than
retroactively treating that failed run as a pass.

## Provision or recover

Inspect the exact repository's runner inventory and the existing Compose stack
first. Reuse an existing registration; do not replace it or delete its volumes
while a job is running. This recipe needs Docker/Compose access on Prometheus
and repository administration access locally. It needs no organization-wide
runner permission or PAT on the server.

Copy this directory's files to the stack directory. Before replacing existing
files, make timestamped backups and preserve its policy and registration.
Build and start the private daemon:

```sh
cd /var/docker/agenticdriver-ci
docker compose config --quiet
docker compose build runner
docker compose up -d --wait docker
# The daemon may have initialized the shared work volume as root.
docker compose run --rm --no-deps -T --user 0 runner chown 1001:1001 /work
```

From the authorized workstation, register once. The short-lived registration
token travels through stdin; the workstation's GitHub credential is not copied:

```sh
set -o pipefail
gh api --method POST repos/agenticdriver/agenticdriver/actions/runners/registration-token --jq .token |
  ssh prometheus 'cd /var/docker/agenticdriver-ci && docker compose run --rm --no-deps -T runner /opt/ci/register.sh https://github.com/agenticdriver/agenticdriver prometheus-agenticdriver-01'
ssh prometheus 'cd /var/docker/agenticdriver-ci && docker compose up -d runner'
gh api repos/agenticdriver/agenticdriver/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

Verify `online` and the exact labels before changing a repository's `runs-on`.
Each other application needs its own repository registration and policy, a
unique Compose project, reviewed resource limits and its own dependencies.
This registration is not an organization runner and cannot serve another repo.
Do not start multiple stacks against the same runner/work/Docker volumes.

To inspect health, use `docker compose ps` and `docker compose logs --tail 80`.
The runner forwards stop signals to its listener with `RUNNER_MANUALLY_TRAP_SIG`
and allows two minutes for shutdown, preserving normal session cleanup.
To suspend acceptance of new jobs, stop the runner while idle with
`docker compose stop runner`; this preserves registration and caches. An offline
runner leaves jobs queued; it never causes a hosted fallback. Rebuild/recreate
only this stack to update root-owned hooks or image prerequisites. Runner binary
updates persist in its volume. Do not run `down --volumes` as routine recovery.
Do not print or copy `.credentials*` from the runner volume.

## Checks and release limits

The SDK workflow runs three Linux runtime combinations, desktop packaging,
documentation, pure validation/process checks and exact release-artifact installation.
It has no fake model endpoint or provider credentials. Real account qualification
runs separately on the authorized Prometheus execution host and records actual
prompts, outputs, CLI versions and usage. A green build is not model qualification.
macOS and Windows execution remain separately qualified.

The manual publisher uses Prometheus for Python/Rust/Go and retains its existing
environment and exact-candidate checks. Those publishing paths require their
registry prerequisites and are not certified merely by changing runner labels.
PyPI organization approval is still pending. PyPA describes self-hosted support
as [best effort](https://github.com/pypa/gh-action-pypi-publish#non-goals).

npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) rejects
self-hosted runners. The `npm` job in `publish.yml` is therefore a dedicated
standard GitHub-hosted Ubuntu publish-only exception, restricted to this public
repository. Standard public-repository runner minutes are free. All builds and
tests remain on Prometheus, with no hosted fallback. The publisher downloads and
verifies the exact successful CI artifact, uses OIDC without a long-lived npm
token, and checks the published digest. See [release controls](../../docs/releases.md#prepare-publication).
