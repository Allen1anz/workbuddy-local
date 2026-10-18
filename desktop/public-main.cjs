const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
app.setName("WorkBuddy Local Open");
const dataRoot = process.env.WORKBUDDY_LOCAL_USER_DATA || path.join(app.getPath("appData"), "WorkBuddy Local Open");
app.setPath("userData", dataRoot);
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
let window, child, stopping = false, origin;
const root = app.isPackaged ? path.join(process.resourcesPath, "app") : path.resolve(__dirname, "..");
const dataDir = path.join(dataRoot, "data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const log = text => fs.appendFileSync(path.join(dataRoot, "desktop.log"), new Date().toISOString() + " " + text + "\n");
async function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 880, minHeight: 620,
    title: "工作伙伴 · 开源版", backgroundColor: "#f7f8fa",
    webPreferences: { preload: path.join(root, "desktop/public-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const external = value => {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol)) shell.openExternal(url.href).catch(error => log(error.message));
  };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  await window.loadURL(origin);
}
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "工作伙伴", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
  ipcMain.handle("public:select-workspace", async event => {
    if (event.sender !== window?.webContents || new URL(event.sender.getURL()).origin !== origin) throw Error("Invalid sender");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  const node = app.isPackaged ? path.join(process.resourcesPath, "runtime/node") : process.execPath;
  child = spawn(node, [path.join(root, "desktop/server-launch.mjs")], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(app.isPackaged ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      WORKBUDDY_RENDERER: "public", WORKBUDDY_DATA_DIR: dataDir,
      WORKBUDDY_OPEN_SKILLS: "1", WORKBUDDY_DEFAULT_WORKSPACE: path.join(app.getPath("home"), "WorkBuddy Local Open"),
      ...(app.isPackaged ? { WORKSPACE_PYTHON: path.join(process.resourcesPath, "runtime/python/bin/python3.12"), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" } : {}),
      WORKBUDDY_LOCAL_PORT: process.env.WORKBUDDY_LOCAL_PORT || "18731",
      WORKBUDDY_OLLAMA_BIN: app.isPackaged ? path.join(process.resourcesPath, "runtime/ollama/ollama") : process.env.WORKBUDDY_OLLAMA_BIN || "",
    },
  });
  let buffer = "", errorText = "";
  const timeout = setTimeout(() => { log("Backend startup timeout"); child.kill(); }, 30000);
  child.stdout.on("data", bytes => {
    buffer += bytes;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.startsWith("WORKBUDDY_READY ")) {
        clearTimeout(timeout); origin = "http://127.0.0.1:" + JSON.parse(line.slice(16)).port;
        createWindow().catch(error => { log(error.stack); dialog.showErrorBox("无法打开工作台", error.message); app.quit(); });
      } else log(line);
    }
  });
  child.stderr.on("data", bytes => { errorText = String(bytes).slice(-2000); log(errorText); });
  child.on("error", error => { clearTimeout(timeout); dialog.showErrorBox("本地服务启动失败", error.message); app.quit(); });
  child.on("exit", () => { clearTimeout(timeout); if (!stopping) { dialog.showErrorBox("本地服务已退出", errorText || "请查看应用数据目录中的 desktop.log"); app.quit(); } });
}).catch(error => { dialog.showErrorBox("启动失败", error.message); app.quit(); });
app.on("activate", () => { if (origin) createWindow(); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { stopping = true; child?.kill("SIGTERM"); });
