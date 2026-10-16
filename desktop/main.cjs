const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
let window,
  settingsWindowHost,
  child,
  origin,
  automationWatch,
  mcpWatch,
  mcpAppsWatch,
  skillWatch,
  expertWatch,
  stopping = false;
const packaged =
  app.isPackaged || fs.existsSync(path.join(process.resourcesPath, "runtime", "node"));
const root = packaged ? path.join(process.resourcesPath, "app") : path.resolve(__dirname, "..");
const mcpWebviewPolicy = require("./mcp-webview.cjs").createMcpWebviewPolicy(
  path.join(root, "tools/mcp-app-preload.cjs"),
);
if (process.env.WORKBUDDY_CDP_PORT)
  app.commandLine.appendSwitch("remote-debugging-port", process.env.WORKBUDDY_CDP_PORT);
app.commandLine.appendSwitch("force-renderer-accessibility");
app.setName("WorkBuddy Local");
const userDataRoot = process.env.WORKBUDDY_LOCAL_USER_DATA
  ? path.resolve(process.env.WORKBUDDY_LOCAL_USER_DATA)
  : path.join(app.getPath("appData"), "WorkBuddy Local");
fs.mkdirSync(userDataRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", userDataRoot);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    app.focus({ steal: true });
  }
});
const dataDir = path.join(app.getPath("userData"), "data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const log = path.join(app.getPath("userData"), "desktop.log");
const writeLog = (text) => fs.appendFileSync(log, new Date().toISOString() + " " + text + "\n");
const localModelManager = require("./local-model.cjs").createLocalModelManager({
  dataDir,
  writeLog,
  emit: (channel, result) =>
    window?.webContents.send("wb-local:event", { type: "event", channel, result }),
});
function validSender(event) {
  return event.sender === window?.webContents || settingsWindowHost?.owns(event.sender);
}
function safeURL(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw Error("Only HTTP(S) URLs supported");
  return url;
}
function shutdown() {
  skillWatch?.close();
  expertWatch?.close();
  automationWatch?.stop();
  mcpWatch?.stop();
  mcpAppsWatch?.stop();
  if (stopping) return;
  stopping = true;
  child?.kill("SIGTERM");
}
async function startBackend() {
  const node = packaged
    ? path.join(process.resourcesPath, "runtime", "node")
    : process.env.WORKBUDDY_NODE || "/usr/local/bin/node";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child?.kill();
      reject(Error("Local backend startup timeout"));
    }, 20000);
    child = spawn(node, [path.join(root, "desktop", "server-launch.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        WORKBUDDY_DATA_DIR: dataDir,
        WORKBUDDY_LOCAL_PORT:
          process.env.WORKBUDDY_LOCAL_PORT ||
          (process.env.WORKBUDDY_LOCAL_QA === "1" ? "18724" : "18723"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "",
      lastError = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      writeLog(text.trim());
      buffer += text;
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        if (line.startsWith("WORKBUDDY_READY ")) {
          clearTimeout(timeout);
          const ready = JSON.parse(line.slice(16));
          origin = "http://127.0.0.1:" + ready.port;
          resolve();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      lastError = chunk.toString().trim().slice(0, 2000);
      writeLog("backend " + lastError);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      writeLog("backend exit " + code);
      clearTimeout(timeout);
      if (!origin) reject(Error(lastError || "Backend exited before ready"));
      else if (!stopping)
        dialog.showErrorBox("本地服务已退出", "请重新打开 WorkBuddy Local。日志：" + log);
    });
  });
}
let lastUserInput = 0;
function openExternal(value) {
  if (Date.now() - lastUserInput > 5000)
    throw Error("External links require a recent user click or key press");
  return shell.openExternal(safeURL(value).href);
}
function installBridge() {
  const conversationListFeed = require("./conversation-list-feed.cjs").createConversationListFeed({
    publish: (sender, channel, result) => { if (!sender.isDestroyed()) sender.send("wb-local:event", { type: "event", channel, result }); },
  });
  const native = require("./native-dispatch.cjs").createNativeDispatcher({
    getWindow: () => window,
    getOrigin: () => origin,
    dataDir,
    log,
    app,
    openExternal,
  });
  const loggerCounts = new Map();
  ipcMain.on("wb-local:log", (event, message) => {
    if (!validSender(event) || !["warn", "warning", "error"].includes(message?.level)) return;
    const text = JSON.stringify(message.data || []).slice(0, 5000);
    const key = message.level + text.slice(0, 200);
    const count = loggerCounts.get(key) || 0;
    if (loggerCounts.size > 2000) loggerCounts.clear();
    loggerCounts.set(key, count + 1);
    if (count < 3) writeLog("local renderer logger " + message.level + " " + text);
  });
  let business;
  try {
    business = require("./dispatcher.cjs").createDispatcher({
      publicExpertCatalog: true,
      origin,
      dataDir,
      getWindow: () => window,
      app,
      openPath: (filename) => shell.openPath(filename),
      emit: (channel, result) => {
        if (channel === "mcpApps:openHostRequested" && !mcpWebviewPolicy.register(result)) return;
        window?.webContents.send("wb-local:event", { type: "event", channel, result });
        settingsWindowHost?.publish(channel, result);
        conversationListFeed.accept(channel, result);
      },
    });
    let snapshotErrorLogged = false;
    const automationSessionSignatures = new Map();
    automationWatch = require("./automation-watch.cjs").createAutomationWatch({
      getSnapshot: () => business("automation:getSnapshot"),
      publish: async (result) => {
        if (stopping || !window || window.isDestroyed()) return;
        const sessions = await business("storage:getSessions");
        if (stopping || !window || window.isDestroyed()) return;
        for (const session of sessions) {
          const signature = JSON.stringify(session);
          if (automationSessionSignatures.get(session.id) === signature) continue;
          window.webContents.send("wb-local:event", {
            type: "event",
            channel: "session:upserted",
            result: session,
          });
          automationSessionSignatures.set(session.id, signature);
        }
        window?.webContents.send("wb-local:event", {
          type: "event",
          channel: "automation:snapshotUpdate",
          result,
        });
      },
      onError: (error) => {
        if (!snapshotErrorLogged) writeLog("automation snapshot refresh failed " + error.message);
        snapshotErrorLogged = true;
      },
    });
    automationWatch.start();
    let mcpRefreshErrorLogged = false;
    mcpWatch = require("./automation-watch.cjs").createAutomationWatch({
      getSnapshot: () => business("mcp:list"),
      getSignature: (servers) => JSON.stringify(servers),
      publish: (servers) => {
        if (!stopping && window && !window.isDestroyed())
          window.webContents.send("wb-local:event", {
            type: "event",
            channel: "session:event",
            result: { type: "mcpServerChange", servers },
          });
      },
      onError: (error) => {
        if (!mcpRefreshErrorLogged) writeLog("MCP snapshot refresh failed " + error.message);
        mcpRefreshErrorLogged = true;
      },
    });
    mcpWatch.start();
    let mcpAppsErrorLogged = false;
    mcpAppsWatch = require("./mcp-app-watch.cjs").createMcpAppWatch({
      getApps: () => business("mcpApps:listApps"),
      publish: (apps) => {
        mcpWebviewPolicy.reconcile(apps);
        if (!stopping && window && !window.isDestroyed())
          window.webContents.send("wb-local:event", {
            type: "event",
            channel: "mcpApps:appsChanged",
            result: apps,
          });
      },
      onError: () => {
        if (!mcpAppsErrorLogged) writeLog("MCP Apps catalog refresh failed");
        mcpAppsErrorLogged = true;
      },
    });
    mcpAppsWatch.start();
  } catch (error) {
    writeLog("local dispatcher unavailable " + error.message);
  }
  const traceQaRpc = require("./qa-rpc-trace.cjs").createQaRpcTrace({
    enabled: process.env.WORKBUDDY_LOCAL_QA === "1" && !!process.env.WORKBUDDY_LOCAL_USER_DATA,
    writeLog,
  });
  ipcMain.handle("wb-local:daemon", async (event, { channel, args }) => {
    if (!validSender(event)) throw Error("Invalid sender");
    traceQaRpc(channel, args);
    const qaPlugin =
      channel.startsWith("plugin:") &&
      process.env.WORKBUDDY_LOCAL_QA === "1" &&
      !!process.env.WORKBUDDY_LOCAL_USER_DATA;
    if (qaPlugin)
      writeLog(
        "QA plugin request " +
          channel +
          " argTypes=" +
          JSON.stringify((args || []).map((value) => typeof value)),
      );
    if (channel === "localModel:configure") return localModelManager.configure(args[0] || {});
    if (channel === "localModel:getConfiguration") return localModelManager.getConfiguration();
    if (channel === "localModel:status") return localModelManager.status();
    if (channel === "localModel:start") return localModelManager.start();
    if (channel === "localModel:stop") return localModelManager.stop();
    const result = await native(channel, args);
    if (!result?.unsupported) return result;
    if (business) {
      try {
        const output = await business(channel, args);
        if (channel === "mcpApps:openHostApp") mcpWebviewPolicy.register(output);
        if (
          channel === "mcpApps:notifyToolCall" &&
          output?.handled &&
          mcpWebviewPolicy.register(output.descriptor)
        )
          window?.webContents.send("wb-local:event", {
            type: "event",
            channel: "mcpApps:openHostRequested",
            result: {
              ...output.descriptor,
              sessionId: args[0]?.sessionId,
              toolCallId: args[0]?.toolCallId,
            },
          });
        if (channel === "mcpApps:closeHostApp") mcpWebviewPolicy.remove(args[0]);
        if (qaPlugin)
          writeLog(
            "QA plugin result " +
              channel +
              " " +
              (Array.isArray(output) ? "count=" + output.length : "type=" + typeof output),
          );
        if (
          channel === "automation:getSnapshot" &&
          process.env.WORKBUDDY_LOCAL_QA === "1" &&
          process.env.WORKBUDDY_LOCAL_USER_DATA
        ) {
          const shape = {};
          for (const [key, value] of Object.entries(output || {})) {
            shape[key] = Array.isArray(value)
              ? { type: "array", count: value.length }
              : { type: typeof value };
          }
          writeLog("QA automation snapshot shape " + JSON.stringify(shape));
        }
        return output;
      } catch (error) {
        writeLog("daemon error " + channel + " " + error.message);
        throw error;
      }
    }
    throw Error("Unsupported local daemon channel: " + channel);
  });
  ipcMain.handle("wb-local:sdk", async (event, { channel, context, args }) => {
    if (!validSender(event)) throw Error("Invalid sender");
    traceQaRpc(channel, args, context);
    if (channel === "wb:internal:conversation-event-subscription") return conversationListFeed.sync(event.sender, args[0]);
    if (settingsWindowHost.handles(channel, args)) return settingsWindowHost.invoke(event.sender, channel, args);
    if (business) {
      try {
        return await business(channel, args, context);
      } catch (error) {
        writeLog("SDK error " + channel + " " + error.message);
        throw error;
      }
    }
    throw Error("Unsupported local SDK channel: " + channel);
  });
  ipcMain.handle("desktop:info", (event) => {
    if (!validSender(event)) throw Error("Invalid sender");
    return { version: app.getVersion(), electron: process.versions.electron, origin, dataDir, log };
  });
  ipcMain.handle("desktop:choose-workspace", async (event) => {
    if (!validSender(event)) throw Error("Invalid sender");
    const result = await dialog.showOpenDialog(window, {
      title: "选择工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("desktop:open-external", async (event, value) => {
    if (!validSender(event)) throw Error("Invalid sender");
    return openExternal(value);
  });
  ipcMain.handle("desktop:download", (event, value) => {
    if (!validSender(event)) throw Error("Invalid sender");
    const url = safeURL(value);
    if (url.origin !== origin) throw Error("Downloads must originate from the local service");
    window.webContents.downloadURL(url.href);
  });
  ipcMain.on("desktop:minimize", (event) => {
    if (validSender(event)) window.minimize();
  });
  ipcMain.on("desktop:maximize", (event) => {
    if (validSender(event)) {
      window.isMaximized() ? window.unmaximize() : window.maximize();
    }
  });
  ipcMain.on("desktop:close", (event) => {
    if (validSender(event)) window.close();
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1470,
    height: 923,
    minWidth: 900,
    minHeight: 600,
    title: "WorkBuddy Local",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(
        root,
        "desktop",
        fs.existsSync(path.join(root, "desktop/preload.bundle.cjs"))
          ? "preload.bundle.cjs"
          : "preload.cjs",
      ),
      additionalArguments: ["--wb-local-config-dir=" + encodeURIComponent(dataDir)],
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true,
      ...(process.env.WORKBUDDY_LOCAL_QA === "1" && process.env.WORKBUDDY_LOCAL_USER_DATA
        ? { backgroundThrottling: false }
        : {}),
    },
  });
  window.webContents.on("will-attach-webview", (event, preferences, params) =>
    mcpWebviewPolicy.attach(event, preferences, params),
  );
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      if (!mcpWebviewPolicy.allowsURL(url)) event.preventDefault();
    });
  });
  if (process.env.WORKBUDDY_LOCAL_QA === "1" && process.env.WORKBUDDY_LOCAL_USER_DATA) {
    const seenConsole = new Map();
    window.webContents.on(
      "console-message",
      (details, legacyLevel, legacyMessage, legacyLine, legacySource) => {
        const severity = details.level || ["debug", "info", "warning", "error"][legacyLevel];
        if (!["warning", "error"].includes(severity)) return;
        const text = String(details.message || legacyMessage || "");
        const source = details.sourceId || legacySource || "";
        const line = details.lineNumber || legacyLine || 0;
        const key = severity + text.slice(0, 300) + source + line;
        const count = seenConsole.get(key) || 0;
        seenConsole.set(key, count + 1);
        if (count >= 3) return;
        writeLog(
          "QA renderer " + severity + " " + text.slice(0, 12000) + " [" + source + ":" + line + "]",
        );
      },
    );
  }
  window.webContents.on("did-fail-load", (_event, code, description, url) =>
    writeLog("renderer load failed " + code + " " + description + " " + url),
  );
  window.webContents.on("render-process-gone", (_event, details) =>
    writeLog("renderer process gone " + JSON.stringify(details)),
  );
  if (process.env.WORKBUDDY_LOCAL_QA === "1" && process.env.WORKBUDDY_LOCAL_USER_DATA)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed =
        ["file:", "data:", "blob:", "devtools:"].includes(url.protocol) ||
        (["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    } catch {}
    if (!allowed) writeLog("blocked renderer request " + details.url.split("?")[0]);
    callback({ cancel: !allowed });
  });
  window.webContents.on("before-mouse-event", (_event, input) => {
    if (input.type === "mouseDown" || input.type === "mouseUp") lastUserInput = Date.now();
  });
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown") lastUserInput = Date.now();
  });
  const publishWindow = (channel, result) =>
    window.webContents.send("wb-local:event", { type: "event", channel, result });
  window.on("maximize", () => publishWindow("window:maximizeChanged", true));
  window.on("unmaximize", () => publishWindow("window:maximizeChanged", false));
  window.on("focus", () => publishWindow("window:focusChanged", true));
  window.on("blur", () => publishWindow("window:focusChanged", false));
  window.on("enter-full-screen", () => publishWindow("window-fullscreen-changed", true));
  window.on("leave-full-screen", () => publishWindow("window-fullscreen-changed", false));
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      openExternal(url);
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.session.on("will-download", (event, item) => {
    item.setSaveDialogOptions({
      title: "保存文件",
      defaultPath: path.join(app.getPath("downloads"), item.getFilename()),
    });
    item.once("done", (_event, state) => writeLog("download " + state + " " + item.getFilename()));
  });
  window.webContents.on("did-finish-load", () =>
    writeLog("renderer ready " + window.webContents.getURL()),
  );
  const menu = [
    {
      label: "WorkBuddy Local",
      submenu: [
        { role: "about" },
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => settingsWindowHost.invoke(window.webContents, "wb:windows:open", [{ appId: "settings" }]).catch(error => writeLog("settings window open failed " + error.message)) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "文件",
      submenu: [
        {
          label: "选择工作目录…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
            if (!result.canceled)
              window.webContents.executeJavaScript(
                `window.dispatchEvent(new CustomEvent("desktop-workspace",{detail:${JSON.stringify(result.filePaths[0])}}))`,
              );
          },
        },
        { role: "close" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  const renderer = process.env.WORKBUDDY_RENDERER_URL || origin;
  await window.loadURL(renderer);
  window.show();
  window.focus();
  app.focus({ steal: true });
  writeLog("desktop ready " + JSON.stringify({ origin, dataDir, pid: process.pid }));
}
app.whenReady().then(async () => {
  try {
    app.setAccessibilitySupportEnabled(true);
    writeLog("native accessibility " + app.isAccessibilitySupportEnabled());
    if (process.platform === "darwin") {
      try {
        app.dock.setIcon(
          packaged
            ? path.join(process.resourcesPath, "icon.icns")
            : path.join(root, "desktop/icon.icns"),
        );
      } catch (error) {
        writeLog("Dock icon fallback " + error.message);
      }
    }
    await startBackend();
    settingsWindowHost = require("./settings-window.cjs").createSettingsWindowHost({
      BrowserWindow, getMainWindow: () => window, origin, configDir: dataDir,
      preload: path.join(root, "desktop", fs.existsSync(path.join(root, "desktop/preload.bundle.cjs")) ? "preload.bundle.cjs" : "preload.cjs"),
    });
    installBridge();
    localModelManager
      .autostart()
      .catch((error) => writeLog("local model startup failed " + error.message));
    await createWindow();
    skillWatch = require("./skill-package-watch.cjs").watchSkillPackages(
      path.join(dataDir, "skills"),
      () => { if (window && !window.webContents.isDestroyed()) window.webContents.send("wb-local:event", { type: "event", channel: "skill:packagesChanged", result: {} }); },
      error => writeLog("skill package watch failed " + error.message),
    );
    expertWatch = require("./skill-package-watch.cjs").watchSkillPackages(
      path.join(path.dirname(dataDir), "expert-config/plugins/marketplaces/my-experts/plugins"),
      () => { if (window && !window.webContents.isDestroyed()) window.webContents.send("wb-local:event", { type: "event", channel: "expert:packagesChanged", result: {} }); },
      error => writeLog("expert package watch failed " + error.message),
    );
  } catch (error) {
    writeLog(error.stack);
    dialog.showErrorBox("启动失败", error.message + "\n日志：" + log);
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!stopping && localModelManager.ownsProcess()) {
    event.preventDefault();
    shutdown();
    localModelManager.stop().finally(() => app.quit());
  } else shutdown();
});
process.on("SIGTERM", () => app.quit());
