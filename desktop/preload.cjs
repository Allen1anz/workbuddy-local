const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "workbuddyDesktop",
  Object.freeze({
    platform: process.platform,
    chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
    download: (url) => ipcRenderer.invoke("desktop:download", url),
    minimize: () => ipcRenderer.send("desktop:minimize"),
    toggleMaximize: () => ipcRenderer.send("desktop:maximize"),
    close: () => ipcRenderer.send("desktop:close"),
    info: () => ipcRenderer.invoke("desktop:info"),
  }),
);
