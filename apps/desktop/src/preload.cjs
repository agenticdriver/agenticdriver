const { contextBridge, ipcRenderer } = require("electron");
const smoke = process.argv.includes("--desktop-smoke");
contextBridge.exposeInMainWorld(
  "agenticDesktop",
  Object.freeze({
    request: (input) => ipcRenderer.invoke("desktop:request", input),
    copyInvitation: (invitation) =>
      ipcRenderer.invoke("desktop:copy-invitation", invitation),
    ...(smoke
      ? {
          smoke: true,
          reportSmoke: (evidence) =>
            ipcRenderer.invoke("desktop:smoke", {
              ...evidence,
              sandboxed: process.sandboxed === true,
              contextIsolated: process.contextIsolated === true,
            }),
        }
      : {}),
  }),
);
