# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /opt/agenticdriver
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/agenticdriver && chown node:node /var/lib/agenticdriver
WORKDIR /opt/agenticdriver
COPY --from=build /opt/agenticdriver/package.json ./
COPY --from=build /opt/agenticdriver/node_modules ./node_modules
COPY --from=build /opt/agenticdriver/dist ./dist
COPY LICENSE ./
COPY deploy/remote-host.mjs ./deploy/remote-host.mjs
USER node
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7433/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "deploy/remote-host.mjs"]
