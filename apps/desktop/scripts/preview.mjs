/** Local development/visual QA only. Production desktop uses IPC, not this HTTP bridge. */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { desktopController, publicError } from "../src/controller.mjs";
import { CSP } from "../src/security.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const ownTemp = !process.env.AGENTICDRIVER_DESKTOP_PREVIEW;
const directory = process.env.AGENTICDRIVER_DESKTOP_PREVIEW
  ? resolve(process.env.AGENTICDRIVER_DESKTOP_PREVIEW)
  : await mkdtemp(join(tmpdir(), "driver-desktop-preview-"));
await mkdir(directory, { recursive: true, mode: 0o700 });
const controller = await desktopController(join(directory, "driver"));
let fixture;
if (process.argv.includes("--fixtures")) {
  const now = new Date().toISOString();
  fixture = createServer((req, res) => {
    const payload =
      req.url === "/v1/providers"
        ? [
            {
              id: "openai",
              displayName: "API account · fixture",
              brandColor: "#9bcab8",
            },
          ]
        : req.url === "/v1/usage"
          ? [
              {
                providerId: "fixture-subscription",
                displayName: "Subscription · synthetic fixture",
                plan: "Example subscription",
                fetchedAt: now,
                source: "Synthetic visual QA",
                state: "ready",
                metrics: [
                  {
                    type: "progress",
                    label: "Current session",
                    used: 24,
                    limit: 100,
                    format: { kind: "percent" },
                    resetsAt: new Date(Date.now() + 7200000).toISOString(),
                  },
                  {
                    type: "progress",
                    label: "Weekly allowance",
                    used: 37,
                    limit: 100,
                    format: { kind: "percent" },
                  },
                ],
              },
              {
                providerId: "fixture-api",
                displayName: "API account · synthetic fixture",
                plan: "Example API usage",
                fetchedAt: now,
                source: "Synthetic visual QA",
                metrics: [
                  {
                    type: "text",
                    label: "Input tokens",
                    value: "18,400 tokens",
                  },
                  {
                    type: "text",
                    label: "Estimated cost",
                    value: "$0.04",
                    subtitle: "Example only · not billed usage",
                  },
                ],
              },
            ]
          : req.url === "/v1/models"
            ? { data: [{ id: "preview-small" }, { id: "preview-large" }] }
            : undefined;
    if (!payload) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await controller.request({ action: "usage-settings", url: fixtureUrl });
  for (const provider of [
    {
      kind: "mock",
      id: "offline-demo",
      accountId: "synthetic-only",
      name: "Offline sandbox",
    },
    {
      kind: "openai-compatible",
      id: "research-fixture",
      name: "Research gateway · fixture",
      accountId: "synthetic-api",
      baseUrl: fixtureUrl + "/v1",
      apiKeyRef: { env: "DESKTOP_UNUSED_FIXTURE" },
    },
  ]) {
    const snapshot = await controller.request({
      action: "panel",
      hostId: "local",
      request: { action: "snapshot" },
    });
    await controller.request({
      action: "panel",
      hostId: "local",
      request: {
        action: "configure",
        change: {
          revision: snapshot.management.revision,
          provider,
          ...(provider.apiKeyRef
            ? { apiKey: "synthetic-fixture-key-no-provider-access" }
            : {}),
        },
      },
    });
  }
}
const key = randomBytes(32).toString("base64url");
const server = createServer((req, res) => {
  void (async () => {
    const authority = req.headers.host;
    if (
      authority !== `127.0.0.1:${server.address().port}` ||
      (req.headers.origin && req.headers.origin !== `http://${authority}`)
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      CSP.replace("connect-src 'none'", "connect-src 'self'"),
    );
    if (req.method === "POST" && req.url === "/desktop-request") {
      const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))
      ) {
        res.writeHead(401).end();
        return;
      }
      if (req.headers["content-type"] !== "application/json") {
        res.writeHead(415).end();
        return;
      }
      let size = 0;
      const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > 1_000_000) {
          res.writeHead(413).end();
          return;
        }
        parts.push(part);
      }
      const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
      res.setHeader("Content-Type", "application/json");
      try {
        res.end(JSON.stringify({ value: await controller.request(input) }));
      } catch (error) {
        res.end(JSON.stringify({ error: publicError(error) }));
      }
      return;
    }
    const path = new Map([
      ["/", "index.html"],
      ["/app.js", "app.js"],
      ["/styles.css", "styles.css"],
      ["/provider-panel.js", "provider-panel.js"],
    ]).get(req.url);
    if (req.method === "GET" && req.url === "/desktop-bridge.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`const key = new URLSearchParams(location.hash.slice(1)).get('preview'); history.replaceState(null, '', '/');
window.agenticDesktop = Object.freeze({request: async input => {const response = await fetch('/desktop-request', {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}, body:JSON.stringify(input),credentials:'omit',cache:'no-store',redirect:'error'}); if(!response.ok) return {error:{message:'Open the current private desktop preview link.'}}; return response.json();}, copyInvitation: text => navigator.clipboard.writeText(text)});`);
      return;
    }
    if (req.method !== "GET" || !path) {
      res.writeHead(404).end();
      return;
    }
    let content = await readFile(join(root, "renderer", path));
    if (path === "index.html")
      content = Buffer.from(
        content
          .toString()
          .replace(
            '<script type="module" src="/app.js">',
            '<script src="/desktop-bridge.js"></script><script type="module" src="/app.js">',
          ),
      );
    res.setHeader(
      "Content-Type",
      path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(content);
  })().catch(() => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
});
server.listen(
  Number(process.env.AGENTICDRIVER_DESKTOP_PREVIEW_PORT ?? 0),
  "127.0.0.1",
);
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
await writeFile(
  join(directory, "launch.json"),
  JSON.stringify({ url: `${url}/#preview=${key}`, pid: process.pid }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    url,
    launchFile: join(directory, "launch.json"),
    synthetic: Boolean(fixture),
  }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await controller.close({ interrupt: true });
  if (fixture) {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
  if (ownTemp) await rm(directory, { recursive: true, force: true });
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
