# Native launch qualification of the already-built Linux artifact; no model/network access.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libasound2 libatk-bridge2.0-0 libgbm1 libgtk-3-0 libnss3 libxss1 xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 desktop
COPY release/linux-unpacked /opt/agenticdriver
COPY --chmod=0644 scripts/native-smoke.mjs /opt/native-smoke.mjs
RUN chown root:root /opt/agenticdriver/chrome-sandbox && chmod 4755 /opt/agenticdriver/chrome-sandbox
USER desktop
ENV AGENTICDRIVER_DESKTOP_HEADLESS=1
ENTRYPOINT ["xvfb-run", "-a", "-s", "-screen 0 1366x900x24", "/opt/agenticdriver/resources/app/runtime/node", "/opt/native-smoke.mjs", "/opt/agenticdriver/agenticdriver-desktop"]
