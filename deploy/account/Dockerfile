# Build the reviewed SDK runtime first; this image adds no provider credentials.
ARG AGENTICDRIVER_IMAGE=agenticdriver:local
FROM ${AGENTICDRIVER_IMAGE}
USER root
RUN mkdir -p /run/secrets /var/lib/agenticdriver /home/node \
    && chown node:node /run/secrets /var/lib/agenticdriver /home/node \
    && chmod 0700 /home/node /var/lib/agenticdriver
COPY --chmod=0555 host.mjs /opt/agenticdriver/deploy/account/host.mjs
USER node
WORKDIR /var/lib/agenticdriver
CMD ["node", "/opt/agenticdriver/deploy/account/host.mjs"]
