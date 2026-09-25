# Offline native fixtures run inside the CI stack's separate Docker daemon.
FROM node:24-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts @openai/codex@0.157.0
RUN node --input-type=module -e '\
    import {readFileSync} from "node:fs"; \
    import {createHash} from "node:crypto"; \
    import assert from "node:assert/strict"; \
    const root="/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/"; \
    for(const [name,sha] of Object.entries({codex:"1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258","codex-code-mode-host":"ae34226adad3fe8acb361a78618e81b5a17638861bb7a689fcccaf8c3ef32aa8"})) \
      assert.equal(createHash("sha256").update(readFileSync(root+name)).digest("hex"),sha);'
WORKDIR /work
ENTRYPOINT ["python3", "/work/scripts/test-codex-native.py", "--binary", "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"]
