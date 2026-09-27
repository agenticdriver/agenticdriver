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
network namespace so loopback TLS fixtures work. Only CI work/temp volumes are
shared for container bind mounts. Prometheus's Docker socket, SSH keys, provider
sessions and deployment credentials are not mounted. The Docker daemon container
is privileged; this configuration is therefore not a hostile-code sandbox.
Runner memory is capped at 8 GiB, nested Docker at 4 GiB. Existing homelab services
are outside this Compose project.

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

The SDK workflow runs three Linux runtime combinations, documentation,
container/TLS deployment fixtures and exact release-artifact installation.
It also runs the pinned real Codex binary against offline synthetic fixtures.
`codex-native.Dockerfile` verifies both native executable hashes. Its test
container has no external network and receives only the checkout and receipt
directory. `SYS_ADMIN`, `NET_ADMIN` and an unconfined seccomp profile let
bubblewrap create the inner test namespaces and their isolated loopback inside
the separate CI Docker daemon; these options
are not added to the runner or a production SDK host. The fixtures do not use
provider credentials and their watchdogs are not SDK timeout defaults.
It uploads the same candidate manifests and checksums as before. A successful
run validates its exact commit, not a package publication or production deploy.
macOS and Windows checks are paused until compatible self-hosted capacity exists;
the last hosted evidence remains historical.

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
