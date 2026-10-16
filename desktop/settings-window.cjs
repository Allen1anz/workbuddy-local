"use strict";
const { randomUUID } = require("node:crypto");
const tabs = new Set(["account", "subscriptionUsage", "settings", "appearance", "keyboardShortcuts", "personalization", "memory", "models", "claw", "deviceConnections", "dataManagement", "buddyApps", "securityCenter", "getHelp"]);

function createSettingsWindowHost({ BrowserWindow, getMainWindow, origin, preload, configDir }) {
  let settingsWindow, payload = {};
  const deliveries = new Map(), sessionStates = new Map();
  const windowEvents = new Set(["wb:windows:opened", "wb:windows:closed", "wb:windows:message", "wb:windows:stateChanged"]);
  function copySmallJson(value) {
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > 65536) throw Error("Window payload exceeds 64 KiB");
    return JSON.parse(json);
  }
  function deliver(target, message) {
    const queue = deliveries.get(target) ?? new Map();
    if (queue.size >= 100) throw Error("Window message queue is full");
    const delivery = { ...message, deliveryId: randomUUID() };
    queue.set(delivery.deliveryId, delivery); deliveries.set(target, queue);
    target.webContents.send("wb-local:event", { type: "event", channel: "wb:windows:message", result: delivery });
    return delivery.deliveryId;
  }
  const owns = sender => sender === getMainWindow()?.webContents || sender === settingsWindow?.webContents;
  const descriptor = target => ({ windowId: target === settingsWindow ? "local:settings" : "local:main", appId: target === settingsWindow ? "settings" : "main" });
  async function open(request, sourceWindowId) {
    if (request?.appId !== "settings") throw Error("Only the local settings window is available");
    const params = request.params ?? {}, route = params.route ?? { tab: "settings" };
    if (!tabs.has(route.tab) || route.subRoute !== undefined && (typeof route.subRoute !== "string" || !route.subRoute.split("/").every(part => {
      try { const decoded = decodeURIComponent(part); return !!decoded && ![".", ".."].includes(decoded) && !/[\x00-\x1f\x7f]/.test(decoded) && encodeURIComponent(decoded) === part; } catch { return false; }
    }))) throw Error("Invalid settings route");
    const nextPayload = copySmallJson({ route, currentConversationId: params.currentConversationId, appearance: params.appearance });
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      deliver(settingsWindow, { kind: "open", payload: nextPayload, sourceWindowId });
      payload = nextPayload;
      settingsWindow.show(); settingsWindow.focus();
      return descriptor(settingsWindow);
    }
    payload = nextPayload;
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      settingsWindow = new BrowserWindow({ width: 900, height: 680, minWidth: 800, minHeight: 640, title: "WorkBuddy Local · 设置", titleBarStyle: "hidden", show: false,
        webPreferences: { preload, additionalArguments: ["--wb-local-config-dir=" + encodeURIComponent(configDir)], contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const target = settingsWindow;
      target.setWindowButtonVisibility?.(false);
      target.on("closed", () => { deliveries.delete(target); sessionStates.delete(target); if (settingsWindow === target) settingsWindow = undefined; });
      target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      target.webContents.on("will-navigate", (event, value) => { if (new URL(value).origin !== origin) event.preventDefault(); });
    }
    const url = new URL(origin);
    url.searchParams.set("locale", "zh-CN");
    url.searchParams.set("windowAppId", "settings");
    url.searchParams.set("windowKind", "settings");
    url.hash = "settings/" + route.tab + (route.subRoute ? "/" + route.subRoute : "");
    await settingsWindow.loadURL(url.href);
    settingsWindow.show(); settingsWindow.focus();
    return descriptor(settingsWindow);
  }
  async function invoke(sender, channel, args = []) {
    if (!owns(sender)) throw Error("Invalid window sender");
    const target = sender === settingsWindow?.webContents ? settingsWindow : getMainWindow();
    const operation = channel.replace(/^wb:windows:/, "");
    if (["wb:$bridge:subscribeEvent", "wb:$bridge:unsubscribeEvent"].includes(channel) && windowEvents.has(args[0]))
      return channel === "wb:$bridge:subscribeEvent" && args[0] === "wb:windows:message" ? [...(deliveries.get(target)?.values() ?? [])] : undefined;
    switch (operation) {
      case "open": return open(args[0], descriptor(target).windowId);
      case "getSelf": return descriptor(target);
      case "getInitialPayload": return target === settingsWindow ? payload : {};
      case "close": target.close(); return;
      case "isMaximized": return target.isMaximized();
      case "maximize": target.maximize(); return;
      case "unmaximize": target.unmaximize(); return;
      case "focus": target.focus(); return;
      case "list": return [getMainWindow(), settingsWindow].filter(item => item && !item.isDestroyed()).map(descriptor);
      case "consumeMessages": return [...(deliveries.get(target)?.values() ?? [])];
      case "ackMessage": return deliveries.get(target)?.delete(args[0]) ?? false;
      case "getSessionState": return copySmallJson(sessionStates.get(target));
      case "setSessionState": sessionStates.set(target, copySmallJson(args[0])); return;
      case "postMessage": {
        const request = args[0], destination = [getMainWindow(), settingsWindow].find(item => item && !item.isDestroyed() && (request?.target?.windowId ? descriptor(item).windowId === request.target.windowId : descriptor(item).appId === request?.target?.appId));
        if (!destination || typeof request.channel !== "string" || !/^[a-zA-Z][a-zA-Z0-9:._-]{0,127}$/.test(request.channel)) throw Error("Invalid local window message target or channel");
        return { deliveryId: deliver(destination, { kind: "message", channel: request.channel, payload: copySmallJson(request.payload), sourceWindowId: descriptor(target).windowId }) };
      }
      default: throw Error("Local window operation is unavailable: " + operation);
    }
  }
  return { owns, invoke, handles(channel, args = []) { return channel.startsWith("wb:windows:") || ["wb:$bridge:subscribeEvent", "wb:$bridge:unsubscribeEvent"].includes(channel) && windowEvents.has(args[0]); }, publish(channel, result) { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send("wb-local:event", { type: "event", channel, result }); } };
}
module.exports = { createSettingsWindowHost };
