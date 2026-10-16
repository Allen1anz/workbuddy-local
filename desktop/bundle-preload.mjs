import fs from "node:fs/promises";
import path from "node:path";
const root = import.meta.dirname;
const bridge = await fs.readFile(path.join(root, "renderer-bridge.cjs"), "utf8");
if (bridge.includes('require("node:crypto")') || bridge.includes("require('node:crypto')"))
  throw Error("Bridge must use browser crypto for sandbox compatibility");
const entry = `const {contextBridge,ipcRenderer,webUtils}=require("electron");
${bridge}
const configArgument=process.argv.find(value=>value.startsWith("--wb-local-config-dir="));
const configDir=configArgument?decodeURIComponent(configArgument.slice("--wb-local-config-dir=".length)):"";
installRendererBridge({contextBridge,ipcRenderer,webUtils,platform:process.platform,arch:process.arch,configDir});
contextBridge.exposeInMainWorld("__electronLog",{sendToMain:message=>ipcRenderer.send("wb-local:log",message)});
`;
await fs.writeFile(path.join(root, "preload.bundle.cjs"), entry);
