import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_URL,
  assetName,
  boundedRequest,
  externalDocumentation,
  trustedSender,
} from "../src/security.mjs";
import { RequestSchema } from "../src/controller.mjs";
test("desktop IPC is restricted to its own main frame and bounded supported operations", () => {
  const frame = { url: APP_URL };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  assert.equal(
    trustedSender({ sender: contents, senderFrame: frame }, contents),
    true,
  );
  assert.equal(
    trustedSender({ sender: {}, senderFrame: frame }, contents),
    false,
  );
  assert.equal(
    trustedSender(
      { sender: contents, senderFrame: { url: APP_URL } },
      contents,
    ),
    false,
  );
  frame.url = "https://example.com/";
  assert.equal(
    trustedSender({ sender: contents, senderFrame: frame }, contents),
    false,
  );
  assert.equal(boundedRequest({ value: "x".repeat(1_000_001) }), false);
  for (const input of [
    { action: "exec", command: "arbitrary" },
    { action: "overview", path: "/private" },
    { action: "panel", hostId: "local", request: { action: "configure" } },
    {
      action: "usage-settings",
      url: "https://example.com",
      tokenFile: "/private",
    },
  ])
    assert.equal(RequestSchema.safeParse(input).success, false);
});
test("only bundled assets and selected documentation URLs can leave the local app boundary", () => {
  assert.equal(assetName(APP_URL), "index.html");
  for (const value of [
    "agenticdriver://evil/",
    "agenticdriver://app/private.key",
    "agenticdriver://app/styles.css?path=/secret",
    "file:///etc/passwd",
  ])
    assert.equal(assetName(value), undefined);
  assert.ok(externalDocumentation("https://developers.openai.com/codex/cli/"));
  for (const value of [
    "javascript:alert(1)",
    "file:///private",
    "https://developers.openai.com.evil.example/",
    "https://user:pass@developers.openai.com/",
  ])
    assert.equal(externalDocumentation(value), undefined);
});
