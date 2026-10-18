const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("publicDesktop", { selectWorkspace: () => ipcRenderer.invoke("public:select-workspace") });
