import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { providerPanel } from "./panel.js";
import {
  connectClient,
  connectedClient,
  readConnectionProfile,
  type ConnectionProfile,
} from "./connection-profile.js";
import { publicError, DriverError } from "./errors.js";
import { isLoopback } from "./security.js";

/** Optional local management application. Embedding applications use providerPanel with their own auth. */
export async function serveProviderPanel(options: {
  connectionPath: string;
  port?: number;
  host?: string;
  script?: string;
}) {
  const host = options.host ?? "127.0.0.1",
    path = resolve(options.connectionPath);
  // Protect the local operator's host credential from other OS users/processes
  // that can reach loopback but cannot read this user's private files/terminal.
  const panelKey = randomBytes(32).toString("base64url");
  if (!isLoopback(host))
    throw new DriverError(
      "LOOPBACK_REQUIRED",
      "The standalone management panel binds to loopback. Embed it behind your application's authorization for remote browsers.",
    );
  const script =
    options.script ??
    (await readFile(new URL("./provider-panel.js", import.meta.url), "utf8"));
  let descriptor: ConnectionProfile | undefined;
  const load = async () => {
    try {
      descriptor = await readConnectionProfile(path);
      return await connectedClient(path);
    } catch (error) {
      if (!(
        error instanceof DriverError && error.code === "CONNECTION_EXPIRED"
      ))
        descriptor = undefined;
      if (
        error instanceof DriverError &&
        ["CONNECTION_REQUIRED", "CONNECTION_EXPIRED"].includes(error.code)
      )
        return undefined;
      throw error;
    }
  };
  let mutation = false;
  const dispatch = providerPanel({
    client: load,
    connection: () =>
      descriptor
        ? {
            id: descriptor.id,
            label: new URL(descriptor.url).host,
            url: descriptor.url,
          }
        : undefined,
    connect: async (invitation) => {
      if (mutation)
        throw new DriverError(
          "CONNECTION_BUSY",
          "A connection change is already in progress.",
        );
      mutation = true;
      try {
        await connectClient(invitation, path);
      } finally {
        mutation = false;
      }
    },
    disconnect: async () => {
      if (mutation)
        throw new DriverError(
          "CONNECTION_BUSY",
          "A connection change is already in progress.",
        );
      mutation = true;
      try {
        await load();
        if (descriptor) {
          // The profile loader validates that tokenFile is a sibling credential basename.
          await rm(path, { force: true });
          await rm(join(dirname(path), descriptor.tokenFile), { force: true });
          descriptor = undefined;
        }
      } finally {
        mutation = false;
      }
    },
  });
  async function body(req: IncomingMessage) {
    let size = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 1_000_000)
        throw new DriverError(
          "BODY_TOO_LARGE",
          "The panel request is too large.",
        );
      parts.push(bytes);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(parts)),
      );
    } catch {
      throw new DriverError(
        "INVALID_REQUEST",
        "The panel request must contain valid JSON.",
      );
    }
  }
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      const authority = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(authority))
        throw new DriverError("FORBIDDEN", "Use the loopback panel URL.");
      if (req.headers.origin && req.headers.origin !== `http://${authority}`)
        throw new DriverError(
          "FORBIDDEN",
          "This browser origin cannot access the panel.",
        );
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgenticDriver · Providers</title><link rel="stylesheet" href="/assets/panel-page.css"><main><agenticdriver-providers></agenticdriver-providers></main><script type="module" src="/assets/panel-session.js"></script></html>`,
        );
      } else if (req.method === "GET" && req.url === "/assets/panel-page.css") {
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        res.end(
          "body{margin:0;padding:36px;background:#171c2b}main{max-width:1220px;margin:0 auto}@media(max-width:760px){body{padding:10px}}",
        );
      } else if (
        req.method === "GET" &&
        req.url === "/assets/panel-session.js"
      ) {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(`import "/assets/agenticdriver-panel.js";
const storageKey = "agenticdriver.local-panel-session";
let key = new URLSearchParams(location.hash.slice(1)).get("panel");
if (key) { try { sessionStorage.setItem(storageKey, key); } catch {} history.replaceState(null, "", location.pathname); }
else { try { key = sessionStorage.getItem(storageKey); } catch {} }
const panel = document.querySelector("agenticdriver-providers");
panel.transport = async request => {
  if (!key) throw new Error("Open the private panel link printed in your terminal.");
  const response = await fetch("/api/agenticdriver-panel", {method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer " + key}, body:JSON.stringify(request), credentials:"omit", cache:"no-store", redirect:"error"});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The panel request failed.");
  return result;
};
await panel.refresh();`);
      } else if (
        req.method === "GET" &&
        req.url === "/assets/agenticdriver-panel.js"
      ) {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(script);
      } else if (
        req.method === "POST" &&
        req.url === "/api/agenticdriver-panel"
      ) {
        const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(key) ||
          !timingSafeEqual(Buffer.from(key), Buffer.from(panelKey))
        )
          throw new DriverError(
            "UNAUTHORIZED",
            "Open the current private panel link from your terminal.",
          );
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          throw new DriverError(
            "INVALID_REQUEST",
            "Use an application/json panel request.",
          );
        const request = await body(req);
        let result: unknown;
        try {
          result = await dispatch(request);
        } catch (error) {
          if (!descriptor || !["snapshot", "connect"].includes(request?.action))
            throw error;
          result = {
            connected: false,
            providers: [],
            connection: {
              id: descriptor.id,
              label: new URL(descriptor.url).host,
              url: descriptor.url,
            },
            canConnect: true,
            canDisconnect: true,
            canInvite: false,
            connectionError: publicError(error).message,
          };
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(404);
        res.end();
      }
    })().catch((error) => {
      const failure = publicError(error);
      res.writeHead(
        failure.code === "FORBIDDEN"
          ? 403
          : failure.code === "UNAUTHORIZED"
            ? 401
            : 400,
        {
          "Content-Type": "application/json",
        },
      );
      res.end(JSON.stringify({ error: failure.toJSON() }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7444, host, () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Panel listener unavailable.");
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    /** Private operator link. Its short-lived panel key is unrelated to the host credential. */
    launchUrl: `${url}/#panel=${panelKey}`,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
        server.closeAllConnections();
      }),
  };
}
