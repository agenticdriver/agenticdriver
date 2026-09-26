# The actual pinned native CLI runs with synthetic credentials and no external network.
FROM node:24-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/claude --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-code-linux-x64@2.1.282
RUN node --input-type=module -e '\
    import {readFileSync} from "node:fs"; \
    import {createHash} from "node:crypto"; \
    import assert from "node:assert/strict"; \
    assert.equal(createHash("sha256").update(readFileSync("/opt/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude")).digest("hex"),"3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3");'
WORKDIR /work
ENTRYPOINT ["python3", "/work/scripts/test-claude-catalog-native.py", "--binary", "/opt/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude"]
