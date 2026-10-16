"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSettingsWindowHost } = require("./settings-window.cjs");

test("settings window reuses its host, carries routes, broadcasts and recreates after close", async () => {
  const created = [];
  class FakeWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.messages = []; this.webContents.send = (...args) => this.messages.push(args); this.webContents.setWindowOpenHandler = handler => this.openHandler = handler; created.push(this); }
    isDestroyed() { return !!this.destroyed; }
    async loadURL(url) { this.url = url; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    close() { this.destroyed = true; this.emit("closed"); }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    isMaximized() { return !!this.maximized; }
  }
  const main = new FakeWindow({});
  const host = createSettingsWindowHost({ BrowserWindow: FakeWindow, getMainWindow: () => main, origin: "http://127.0.0.1:18723", preload: "/local/preload.cjs", configDir: "/local/data" });
  await assert.rejects(host.invoke({}, "wb:windows:open", [{ appId: "settings" }]), /sender/);
  await assert.rejects(host.invoke(main.webContents, "wb:windows:open", [{ appId: "extension-url", url: "https://example.invalid" }]), /Only/);
  await host.invoke(main.webContents, "wb:windows:open", [{ appId: "settings", params: { route: { tab: "models" } } }]);
  const settings = created[1];
  assert.equal(created.length, 2);
  assert.equal(settings.options.width, 900);
  assert.equal(settings.options.webPreferences.nodeIntegration, false);
  assert.equal(settings.options.webPreferences.sandbox, true);
  assert.equal(new URL(settings.url).hash, "#settings/models");
  assert.equal(settings.visible, true);
  assert.deepEqual(await host.invoke(settings.webContents, "wb:windows:getInitialPayload"), { route: { tab: "models" } });
  await host.invoke(main.webContents, "wb:windows:open", [{ appId: "settings", params: { route: { tab: "memory" } } }]);
  assert.equal(created.length, 2);
  assert.equal(new URL(settings.url).hash, "#settings/models");
  const pending = await host.invoke(settings.webContents, "wb:windows:consumeMessages");
  assert.equal(pending[0].kind, "open");
  assert.equal(pending[0].payload.route.tab, "memory");
  assert.equal(await host.invoke(settings.webContents, "wb:windows:ackMessage", [pending[0].deliveryId]), true);
  assert.deepEqual(await host.invoke(settings.webContents, "wb:windows:consumeMessages"), []);
  settings.messages.length = 0;
  host.publish("config:changed", { key: "theme", value: "dark" });
  assert.equal(settings.messages[0][1].channel, "config:changed");
  assert.deepEqual(settings.openHandler({ url: "https://example.invalid" }), { action: "deny" });
  let denied = false;
  settings.webContents.emit("will-navigate", { preventDefault() { denied = true; } }, "https://example.invalid");
  assert.equal(denied, true);
  const message = await host.invoke(main.webContents, "wb:windows:postMessage", [{ target: { appId: "settings" }, channel: "settings:current-conversation", payload: { currentConversationId: "test-only" } }]);
  assert.equal((await host.invoke(settings.webContents, "wb:$bridge:subscribeEvent", ["wb:windows:message"]))[0].sourceWindowId, "local:main");
  assert.equal(await host.invoke(main.webContents, "wb:windows:ackMessage", [message.deliveryId]), false);
  assert.equal(await host.invoke(settings.webContents, "wb:windows:ackMessage", [message.deliveryId]), true);
  assert.equal(await host.invoke(settings.webContents, "wb:$bridge:unsubscribeEvent", ["wb:windows:message"]), undefined);
  await host.invoke(settings.webContents, "wb:windows:setSessionState", [{ panel: "memory" }]);
  assert.deepEqual(await host.invoke(settings.webContents, "wb:windows:getSessionState"), { panel: "memory" });
  assert.equal(await host.invoke(main.webContents, "wb:windows:getSessionState"), null);
  await assert.rejects(host.invoke(main.webContents, "wb:windows:postMessage", [{ target: { appId: "external" }, channel: "test", payload: {} }]), /target/);
  await assert.rejects(host.invoke(settings.webContents, "wb:windows:setSessionState", ["x".repeat(65537)]), /64 KiB/);
  await assert.rejects(host.invoke(main.webContents, "wb:windows:open", [{ appId: "settings", params: { route: { tab: "models", subRoute: ".." } } }]), /route/);
  await host.invoke(settings.webContents, "wb:windows:close");
  assert.equal(host.owns(settings.webContents), false);
  await host.invoke(main.webContents, "wb:windows:open", [{ appId: "settings" }]);
  assert.equal(created.length, 3);
});
