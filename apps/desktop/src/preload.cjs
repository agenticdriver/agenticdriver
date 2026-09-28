const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "agenticDesktop",
  Object.freeze({
    request: (input) => ipcRenderer.invoke("desktop:request", input),
    copyInvitation: (invitation) =>
      ipcRenderer.invoke("desktop:copy-invitation", invitation),
  }),
);
