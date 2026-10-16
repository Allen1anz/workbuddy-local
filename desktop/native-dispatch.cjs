const {
  dialog,
  shell,
  clipboard,
  nativeImage,
  Notification,
  Menu,
  powerSaveBlocker,
  globalShortcut,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
function createNativeDispatcher({ getWindow, getOrigin, dataDir, log, app, openExternal }) {
  const machineFile = path.join(dataDir, "local-machine-id");
  if (!fs.existsSync(machineFile)) fs.writeFileSync(machineFile, randomUUID(), { mode: 0o600 });
  const url = (value) => {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) throw Error("Only HTTP(S) URLs supported");
    return u;
  };
  let reportCount = 0,perfCount=0;
  const preferencesFile = path.join(dataDir, "native-settings.json");
  let preferences = {}, preferencesError = null;
  if (fs.existsSync(preferencesFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(preferencesFile, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw Error("Native settings must be an object");
      preferences = saved;
    } catch (error) {
      preferencesError = error.message;
      if (log) {
        try { fs.appendFileSync(log, new Date().toISOString() + " native settings read failed: " + preferencesError + "\n"); } catch {}
      }
    }
  }
  let powerBlockerId = preferences.keepAwake === true ? powerSaveBlocker.start("prevent-display-sleep") : -1;
  let toggleAccelerator = "";
  function registerToggleWindow(accelerator) {
    if (toggleAccelerator) globalShortcut.unregister(toggleAccelerator);
    toggleAccelerator = "";
    let success = !accelerator;
    if (accelerator) {
      try {
        success = globalShortcut.register(accelerator, () => {
          const target = getWindow();
          if (!target || target.isDestroyed()) return;
          if (target.isVisible() && target.isFocused()) target.hide();
          else { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
        });
        if (success) toggleAccelerator = accelerator;
      } catch { success = false; }
    }
    getWindow()?.webContents.send("wb-local:event", { type: "event", channel: "globalShortcut:registrationStatus", result: { success, accelerator } });
    return success;
  }
  if (globalShortcut) registerToggleWindow(preferences.toggleWindowAccelerator ?? "Shift+Alt+W");
  app.once?.("will-quit", () => {
    if (toggleAccelerator) globalShortcut.unregister(toggleAccelerator);
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
  });
  return async (channel, args = []) => {
    const window = getWindow(),
      value = args[0];
    switch (channel) {
      case "workbuddy:globalShortcut:updateToggleWindow": {
        if (typeof value !== "string" || value.length > 100) throw Error("Shortcut accelerator must be a string under 100 characters");
        const previous = preferences.toggleWindowAccelerator ?? "Shift+Alt+W";
        const success = registerToggleWindow(value);
        const next = { ...preferences, toggleWindowAccelerator: value };
        const temporary = preferencesFile + "." + randomUUID() + ".tmp";
        try {
          fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, preferencesFile);
        } catch (error) { registerToggleWindow(previous); throw error; }
        preferences = next;
        preferencesError = null;
        return { success, accelerator: value };
      }
      case "perf:appendLine":
        if(perfCount++<100)fs.appendFileSync(log,new Date().toISOString()+" local performance "+String(value).slice(0,2048)+"\n");
        return null;
      case "dialog:saveFile":
        return dialog.showSaveDialog(window, value || {});
      case "dialog:pickFile": {
        const options = value || {},
          properties = options.properties || ["openFile"];
        if (options.canSelectMany && !properties.includes("multiSelections"))
          properties.push("multiSelections");
        const result = await dialog.showOpenDialog(window, {
          title: options.title,
          defaultPath: options.defaultPath,
          filters: options.filters,
          properties,
        });
        return { canceled: result.canceled, files: result.filePaths };
      }
      case "dialog:pickFolder": {
        const options = value || {},
          properties = options.properties
            ? [...options.properties]
            : ["openDirectory", "createDirectory"];
        if (options.canSelectMany && !properties.includes("multiSelections"))
          properties.push("multiSelections");
        const installDir = path.resolve(path.dirname(app.getPath("exe")), "../..");
        for (;;) {
          const result = await dialog.showOpenDialog(window, {
            title: options.title,
            defaultPath: options.defaultPath,
            filters: options.filters,
            properties,
          });
          if (result.canceled || !result.filePaths.length)
            return { canceled: true, folderPaths: [] };
          const picked = fs.realpathSync(result.filePaths[0]);
          if (picked === installDir || picked.startsWith(installDir + path.sep)) {
            await dialog.showMessageBox(window, {
              type: "warning",
              title: "选择工作目录",
              message: "不能将应用安装包目录用作工作目录。",
              buttons: ["确定"],
            });
            continue;
          }
          return { canceled: false, folderPaths: result.filePaths };
        }
      }

      case "app:getAutoLaunchEnabled":
        return app.getLoginItemSettings().openAtLogin === true;
      case "app:setAutoLaunchEnabled": {
        if (typeof value !== "boolean") throw Error("Auto launch enabled must be boolean");
        const previous = app.getLoginItemSettings().openAtLogin === true;
        app.setLoginItemSettings({ openAtLogin: value });
        if ((app.getLoginItemSettings().openAtLogin === true) !== value) {
          app.setLoginItemSettings({ openAtLogin: previous });
          throw Error("Auto launch state did not match requested setting");
        }
        return null;
      }
      case "window:getPowerSaveBlockerState":
        return { isEnabled: preferences.keepAwake === true, isActive: powerSaveBlocker.isStarted(powerBlockerId) };
      case "window:setPowerSaveBlocker": {
        if (typeof value !== "boolean") throw Error("Keep awake enabled must be boolean");
        const next = { ...preferences, keepAwake: value };
        const temporary = preferencesFile + "." + randomUUID() + ".tmp";
        const nextId = value && !powerSaveBlocker.isStarted(powerBlockerId)
          ? powerSaveBlocker.start("prevent-display-sleep") : powerBlockerId;
        try {
          fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, preferencesFile);
        } catch (error) {
          if (nextId !== powerBlockerId) powerSaveBlocker.stop(nextId);
          throw error;
        }
        if (!value && powerSaveBlocker.isStarted(nextId)) powerSaveBlocker.stop(nextId);
        powerBlockerId = value ? nextId : -1;
        preferences = next;
        preferencesError = null;
        return { isEnabled: value, isActive: powerSaveBlocker.isStarted(powerBlockerId) };
      }
      case "crash:renderer-js-error":
        if (reportCount++ < 50)
          fs.appendFileSync(
            log,
            new Date().toISOString() +
              " renderer diagnostic " +
              JSON.stringify(args).slice(0, 3000) +
              "\n",
          );
        return null;
      case "app:setMenuLocale": {
        const english = String(value?.locale || value || "").startsWith("en");
        const menu = Menu.getApplicationMenu();
        const labels = english
          ? ["WorkBuddy Local", "File", "Edit", "View", "Window"]
          : ["WorkBuddy Local", "文件", "编辑", "视图", "窗口"];
        menu?.items.forEach((item, index) => {
          if (labels[index]) item.label = labels[index];
        });
        return null;
      }
      case "workbuddy:window:minimize":
        window.minimize();
        return null;
      case "workbuddy:window:maximize":
        window.isMaximized() ? window.unmaximize() : window.maximize();
        return null;
      case "workbuddy:window:close":
        window.close();
        return null;
      case "workbuddy:window:isMaximized":
        return window.isMaximized();
      case "workbuddy:window:isFullscreen":
        return window.isFullScreen();
      case "workbuddy:window:setFullscreen":
        window.setFullScreen(!!value);
        return null;
      case "workbuddy:window:toggleFullscreen":
        window.setFullScreen(!window.isFullScreen());
        return null;
      case "workbuddy:window:startDrag":
      case "workbuddy:window:stopDrag":
        return null;
      case "window:selectDirectory":
      case "workbuddy:dialog:open": {
        const options = value || {},
          properties =
            options.directory || channel === "window:selectDirectory"
              ? ["openDirectory", "createDirectory"]
              : ["openFile"];
        if (options.multiple) properties.push("multiSelections");
        const result = await dialog.showOpenDialog(window, {
          title: options.title,
          defaultPath: options.defaultPath,
          properties,
          filters: options.filters,
        });
        return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0];
      }
      case "workbuddy:opener:openUrl":
        return openExternal(url(value).href);
      case "workbuddy:localFile:open": {
        const p = typeof value === "string" ? value : value?.path;
        if (!p) throw Error("File path required");
        const error = await shell.openPath(p);
        if (error) throw Error(error);
        return null;
      }
      case "workbuddy:clipboard:readText":
        return clipboard.readText();
      case "workbuddy:clipboard:writeText":
        clipboard.writeText(String(value));
        return null;
      case "workbuddy:clipboard:writeImage":
        clipboard.writeImage(nativeImage.createFromDataURL(value));
        return null;
      case "workbuddy:machineId":
        return fs.readFileSync(machineFile, "utf8");
      case "app:consumePendingOpenUrls":
        return [];
      case "workbuddy:notification:isSupported":
        return Notification.isSupported();
      case "workbuddy:notification:requestRegistration":
        return Notification.isSupported() ? "granted" : "denied";
      case "workbuddy:notification:send":
        if (!Notification.isSupported()) throw Error("Native notifications unavailable");
        new Notification({
          title: value?.title || "WorkBuddy Local",
          body: value?.body || "",
        }).show();
        return null;
      case "dialog:saveImage": {
        const image = nativeImage.createFromDataURL(value);
        if (image.isEmpty()) throw Error("Invalid image");
        const result = await dialog.showSaveDialog(window, { defaultPath: args[1] || "image.png" });
        if (result.canceled) return null;
        fs.writeFileSync(result.filePath, image.toPNG());
        return result.filePath;
      }
      case "desktop:download": {
        const u = url(value);
        if (u.origin !== getOrigin()) throw Error("Only local service downloads allowed");
        window.webContents.downloadURL(u.href);
        return null;
      }
      case "desktop:info":
        return {
          origin: getOrigin(),
          dataDir,
          log,
          version: app.getVersion(),
          electron: process.versions.electron,
          nativeSettingsError: preferencesError,
        };
      default:
        return { unsupported: true };
    }
  };
}
module.exports = { createNativeDispatcher };
