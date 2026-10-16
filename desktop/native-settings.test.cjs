const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
test("native settings validate, confirm login state and restore keep-awake preference", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-native-settings-"));
  let nextId = 0, login = false;
  const active = new Set();
  const powerSaveBlocker = {
    start(type) { assert.equal(type, "prevent-display-sleep"); active.add(++nextId); return nextId; },
    stop(id) { active.delete(id); }, isStarted(id) { return active.has(id); },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-dispatch.cjs"), "utf8"), {
    module, require(name) { return name === "electron" ? { powerSaveBlocker } : require(name); },
    URL,
  });
  const options = { dataDir, getWindow: () => null, app: {
    getLoginItemSettings: () => ({ openAtLogin: login }),
    setLoginItemSettings: (value) => { login = value.openAtLogin; },
  } };
  const dispatch = module.exports.createNativeDispatcher(options);
  await assert.rejects(dispatch("app:setAutoLaunchEnabled", ["yes"]));
  await dispatch("app:setAutoLaunchEnabled", [true]);
  assert.equal(await dispatch("app:getAutoLaunchEnabled"), true);
  await dispatch("app:setAutoLaunchEnabled", [false]);
  assert.equal(await dispatch("app:getAutoLaunchEnabled"), false);
  await assert.rejects(dispatch("window:setPowerSaveBlocker", [1]));
  const enabled = await dispatch("window:setPowerSaveBlocker", [true]);
  assert.equal(enabled.isActive, true);
  active.clear();
  const reopened = module.exports.createNativeDispatcher(options);
  assert.equal((await reopened("window:getPowerSaveBlockerState")).isEnabled, true);
  assert.equal((await reopened("window:getPowerSaveBlockerState")).isActive, true);
  await reopened("window:setPowerSaveBlocker", [false]);
  assert.equal(active.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "native-settings.json"))).keepAwake, false);
});

test("toggle-window shortcut registers, persists, reports collisions and restores the window", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-native-shortcut-"));
  const callbacks = new Map(), events = [];
  const globalShortcut = {
    register(accelerator, callback) { if (accelerator === "Occupied") return false; callbacks.set(accelerator, callback); return true; },
    unregister(accelerator) { callbacks.delete(accelerator); },
  };
  let visible = true, focused = true, minimized = false;
  const window = {
    isDestroyed: () => false, isVisible: () => visible, isFocused: () => focused,
    isMinimized: () => minimized, hide: () => { visible = false; },
    restore: () => { minimized = false; }, show: () => { visible = true; }, focus: () => { focused = true; },
    webContents: { send: (channel, value) => events.push({ channel, value }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-dispatch.cjs"), "utf8"), {
    module, require(name) { return name === "electron" ? { globalShortcut, powerSaveBlocker: { isStarted: () => false } } : require(name); }, URL,
  });
  const options = { dataDir, getWindow: () => window, app: {} };
  const dispatch = module.exports.createNativeDispatcher(options);
  assert(callbacks.has("Shift+Alt+W"));
  callbacks.get("Shift+Alt+W")(); assert.equal(visible, false);
  minimized = true; callbacks.get("Shift+Alt+W")(); assert.equal(visible, true); assert.equal(minimized, false);
  assert.equal((await dispatch("workbuddy:globalShortcut:updateToggleWindow", ["Ctrl+Alt+W"])).success, true);
  assert(!callbacks.has("Shift+Alt+W")); assert(callbacks.has("Ctrl+Alt+W"));
  callbacks.clear(); module.exports.createNativeDispatcher(options); assert(callbacks.has("Ctrl+Alt+W"));
  assert.equal((await dispatch("workbuddy:globalShortcut:updateToggleWindow", ["Occupied"])).success, false);
  assert.equal(events.at(-1).value.result.success, false);
  await dispatch("workbuddy:globalShortcut:updateToggleWindow", [""]); assert.equal(callbacks.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "native-settings.json"))).toggleWindowAccelerator, "");
  await assert.rejects(dispatch("workbuddy:globalShortcut:updateToggleWindow", [null]));
  const settingsFile = path.join(dataDir, "native-settings.json");
  fs.renameSync(settingsFile, settingsFile + ".saved"); fs.mkdirSync(settingsFile);
  await assert.rejects(dispatch("workbuddy:globalShortcut:updateToggleWindow", ["Ctrl+W"]));
  assert.equal(callbacks.size, 0);
});
test("corrupt native preferences do not prevent startup or overwrite the corrupt file", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-native-corrupt-"));
  const filename = path.join(dataDir, "native-settings.json");
  fs.writeFileSync(filename, "{invalid");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-dispatch.cjs"), "utf8"), {
    module, require(name) { return name === "electron" ? { powerSaveBlocker: { isStarted: () => false } } : require(name); }, URL,
  });
  const dispatch = module.exports.createNativeDispatcher({ dataDir, getWindow: () => null, app: { getVersion: () => "0.1.0" } });
  assert.equal((await dispatch("window:getPowerSaveBlockerState")).isEnabled, false);
  assert.equal(fs.readFileSync(filename, "utf8"), "{invalid");
});
