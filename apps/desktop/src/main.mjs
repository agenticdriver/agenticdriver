import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} from "electron";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startWorker } from "./worker-client.mjs";
import {
  APP_URL,
  CSP,
  assetName,
  boundedRequest,
  externalDocumentation,
  trustedSender,
} from "./security.mjs";

app.setName("AgenticDriver");
if (process.env.AGENTICDRIVER_DESKTOP_DATA) {
  const profile = resolve(process.env.AGENTICDRIVER_DESKTOP_DATA);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath("userData", profile);
}
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "agenticdriver",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const smoke = process.argv.includes("--smoke-test");
let window,
  worker,
  quitting = false,
  quitPending = false;
const root = fileURLToPath(new URL("../", import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const ses = session.defaultSession;
      ses.setPermissionCheckHandler(
        (_wc, permission, requestingOrigin) =>
          permission === "clipboard-sanitized-write" &&
          requestingOrigin === "agenticdriver://app",
      );
      ses.setPermissionRequestHandler((wc, permission, callback) =>
        callback(
          wc === window?.webContents &&
            wc.getURL() === APP_URL &&
            permission === "clipboard-sanitized-write",
        ),
      );
      protocol.handle("agenticdriver", async (request) => {
        const file = assetName(request.url);
        if (!file || request.method !== "GET")
          return new Response("Not found", { status: 404 });
        const type = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html";
        return new Response(await readFile(join(root, "renderer", file)), {
          headers: {
            "Content-Type": type + "; charset=utf-8",
            "Content-Security-Policy": CSP,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      });
      const authorize = (event) => {
        if (!trustedSender(event, window?.webContents))
          throw new Error("This frame cannot access the desktop.");
      };
      ipcMain.handle("desktop:request", async (event, input) => {
        authorize(event);
        if (!boundedRequest(input))
          return {
            error: {
              code: "INVALID_DESKTOP_REQUEST",
              message: "The desktop request is too large.",
            },
          };
        try {
          await worker.ready;
          return { value: await worker.request(input) };
        } catch (error) {
          return {
            error: {
              code:
                typeof error.code === "string"
                  ? error.code
                  : "DESKTOP_UNAVAILABLE",
              message: error.message || "The desktop host is unavailable.",
            },
          };
        }
      });
      ipcMain.handle("desktop:copy-invitation", (event, value) => {
        authorize(event);
        if (
          typeof value !== "string" ||
          !/^ad1\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{43}$/.test(value)
        )
          throw new Error("Choose a complete one-use invitation.");
        clipboard.writeText(value);
        return true;
      });
      if (smoke)
        ipcMain.handle("desktop:smoke", async (event, evidence) => {
          authorize(event);
          const prefs = window.webContents.getLastWebPreferences();
          const valid =
            evidence?.sandboxed &&
            evidence.contextIsolated &&
            evidence.nodeUnavailable &&
            evidence.providerAdded &&
            evidence.providerSetupUi &&
            evidence.providerRemovalUi &&
            evidence.strictStyleCsp &&
            prefs.sandbox &&
            prefs.contextIsolation &&
            !prefs.nodeIntegration &&
            prefs.webSecurity;
          console.log(
            JSON.stringify({
              desktopSmoke: valid ? "passed" : "failed",
              rendererIsolated: Boolean(valid),
              providerSetupUi: evidence.providerSetupUi === true,
              providerRemovalUi: evidence.providerRemovalUi === true,
              strictStyleCsp: evidence.strictStyleCsp === true,
              runtime: "v24.21.0",
              ...(evidence.startupError
                ? { startupError: evidence.startupError }
                : {}),
            }),
          );
          process.exitCode = valid ? 0 : 1;
          setImmediate(() => app.quit());
          return true;
        });
      worker = startWorker(
        join(app.getPath("userData"), "driver"),
        join(root, "runtime", "node"),
      );
      // Catch startup errors immediately, then let the UI present the same recoverable error.
      worker.ready.catch(() => {});
      window = new BrowserWindow({
        title: "AgenticDriver",
        icon: join(root, "assets", "icon.png"),
        width: 1340,
        height: 920,
        minWidth: 360,
        minHeight: 520,
        backgroundColor: "#151a28",
        show: !smoke,
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(root, "src", "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          additionalArguments: smoke ? ["--desktop-smoke"] : [],
        },
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== APP_URL) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.webContents.setWindowOpenHandler(({ url }) => {
        const approved = externalDocumentation(url);
        if (approved) void shell.openExternal(approved);
        return { action: "deny" };
      });
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          app.quit();
        }
      });
      await window.loadURL(APP_URL);
      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        if (quitPending) return;
        quitPending = true;
        void (async () => {
          try {
            await worker.ready;
            await worker.close(false);
          } catch (error) {
            if (error.code === "HOST_BUSY") {
              const choice = await dialog.showMessageBox(window, {
                type: "question",
                title: "Requests are in progress",
                message:
                  "Quit AgenticDriver and interrupt the local host’s requests?",
                buttons: ["Keep running", "Quit and interrupt"],
                defaultId: 0,
                cancelId: 0,
              });
              if (choice.response !== 1) {
                quitPending = false;
                return;
              }
              await worker.close(true);
            }
          }
          quitting = true;
          app.quit();
        })().catch(() => {
          quitPending = false;
        });
      });
    })
    .catch(() => {
      console.error("AgenticDriver desktop startup failed.");
      app.exit(1);
    });
}
