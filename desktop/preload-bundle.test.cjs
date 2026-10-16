const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { createDispatcher } = require("./dispatcher.cjs");

test("generated sandbox preload decodes Unicode configuration path and routes chat records", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wb-preload-"));
  const dataDir = path.join(parent, "中文 配置 % #", "data"),
    exposed = {},
    calls = [];
  const dispatch = createDispatcher({ dataDir, origin: "http://127.0.0.1:1" });
  const source = await fs.readFile(path.join(__dirname, "preload.bundle.cjs"), "utf8");
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      on() {},
      removeListener() {},
      send() {},
      invoke(channel, envelope) {
        calls.push(channel);
        return dispatch(envelope.channel, envelope.args);
      },
    },
  };
  const context = vm.createContext({
    require(name) {
      assert.equal(name, "electron");
      return electron;
    },
    module: { exports: {} },
    process: {
      platform: "darwin",
      arch: "arm64",
      argv: ["electron", "--wb-local-config-dir=" + encodeURIComponent(dataDir)],
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      localStorage: {
        getItem() {
          return null;
        },
        setItem() {},
      },
    },
    Uint8Array,
    TextDecoder,
  });
  vm.runInContext(source, context, { timeout: 1000 });
  assert.equal(exposed.workbuddyDesktop.configDir, dataDir);
  assert.equal(exposed.workbuddyDesktop.platform, "darwin");
  const filePath = path.join(exposed.workbuddyDesktop.configDir, "logs", "真实记录.jsonl");
  await exposed.workbuddyDesktop.invoke("io:appendRecord", {
    filePath,
    jsonLine: "PRELOAD_真实记录\n",
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "PRELOAD_真实记录\n");
  assert.deepEqual(calls, ["wb-local:daemon"]);
});
