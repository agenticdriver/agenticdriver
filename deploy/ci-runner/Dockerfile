FROM docker:29.5.3-cli AS docker
FROM ubuntu:24.04
ARG RUNNER_VERSION=2.337.0
ARG RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh build-essential pkg-config libssl-dev \
      python3 python3-venv python-is-python3 unzip zip jq openssl poppler-utils \
      libicu74 libkrb5-3 zlib1g liblttng-ust1t64 libunwind8 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1001 --create-home --shell /bin/bash runner \
    && mkdir -p /runner /work /opt/hostedtoolcache \
    && curl --fail --location --retry 3 \
       "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
       -o /tmp/runner.tar.gz \
    && echo "${RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/runner.tar.gz -C /runner && rm /tmp/runner.tar.gz \
    && chown -R runner:runner /runner /work /opt/hostedtoolcache
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --chmod=755 job-started.py register.sh /opt/ci/
COPY --chmod=644 policy.json /opt/ci/
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/ci/job-started.py \
    DOCKER_HOST=tcp://127.0.0.1:2375
USER runner
WORKDIR /runner
CMD ["./run.sh"]
