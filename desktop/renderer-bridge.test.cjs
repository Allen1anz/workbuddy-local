const test = require("node:test"),
  assert = require("node:assert/strict");
const { installRendererBridge } = require("./renderer-bridge.cjs");
test("File upload bridge sends cloneable bytes and preserves file names without forwarding browser objects", async () => {
  const calls = [],
    bridge = installRendererBridge({
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: {
        on() {},
        removeListener() {},
        async invoke(channel, envelope) {
          calls.push({ channel, envelope: structuredClone(envelope) });
          return { success: true };
        },
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
    });
  const file = new File(["BRIDGE_UPLOAD_PROOF"], "中文 文件.txt", { type: "text/plain" });
  await bridge.daemon("file:upload", { files: [file] });
  const sent = calls[0].envelope.args[0].files[0];
  assert.equal(calls[0].channel, "wb-local:daemon");
  assert.equal(sent.name, "中文 文件.txt");
  assert.equal(sent.type, "text/plain");
  assert(sent.data instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(sent.data), "BRIDGE_UPLOAD_PROOF");
  assert.equal(sent.arrayBuffer, undefined);
  const count = calls.length;
  await assert.rejects(
    bridge.daemon("file:upload", { files: [new File(["x".repeat(100001)], "large.txt")] }),
    /100000/,
  );
  assert.equal(calls.length, count);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await bridge.daemon("file:upload", {
    files: [file],
    abortSignal: controller.signal,
  });
  assert.equal(cancelled.aborted, true);
  assert.equal(cancelled.success, false);
  assert.equal(calls.length, count);
  bridge.cleanup();
});

test("original global MCP change event reaches preload subscription and daemon port without a session scope", () => {
  const exposed = {},
    ipcHandlers = new Map(),
    windowHandlers = new Map(),
    win = {
      addEventListener: (name, callback) => windowHandlers.set(name, callback),
      removeEventListener: (name) => windowHandlers.delete(name),
      localStorage: { getItem: () => null, setItem() {} },
    };
  const bridge = installRendererBridge({
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      on: (name, callback) => ipcHandlers.set(name, callback),
      removeListener: (name) => ipcHandlers.delete(name),
      invoke: async () => null,
    },
    window: win,
  });
  const callbacks = [],
    unsubscribe = exposed.__wbOn("session:event", (value) => callbacks.push(value)),
    posted = [],
    port = {
      postMessage: (value) => posted.push(value),
      start() {},
      close() {
        this.closed = true;
      },
    };
  windowHandlers.get("message")({
    source: win,
    data: { type: "workbuddy:open-local-daemon-transport-port" },
    ports: [port],
  });
  const payload = {
    type: "mcpServerChange",
    servers: [{ name: "proof", status: "disabled", tools: [{ name: "read", enabled: false }] }],
  };
  ipcHandlers.get("wb-local:event")(
    {},
    { type: "event", channel: "session:event", result: payload },
  );
  assert.deepEqual(callbacks, [payload]);
  assert.deepEqual(posted.find((message) => message.json?.channel === "session:event").json, {
    type: "event",
    channel: "session:event",
    result: payload,
  });
  unsubscribe();
  ipcHandlers.get("wb-local:event")(
    {},
    { type: "event", channel: "session:event", result: payload },
  );
  assert.equal(callbacks.length, 1);
  bridge.cleanup();
  assert.equal(port.closed, true);
  assert.equal(ipcHandlers.has("wb-local:event"), false);
});

test("renderer receives synchronous configuration directory and appends through actual dispatcher", async () => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    os = require("node:os");
  const { createDispatcher } = require("./dispatcher.cjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-config-dir-")),
    exposed = {},
    dispatch = createDispatcher({ dataDir, origin: "http://127.0.0.1:1" });
  const bridge = installRendererBridge({
    configDir: dataDir,
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      on() {},
      removeListener() {},
      invoke(channel, envelope) {
        return dispatch(envelope.channel, envelope.args);
      },
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
  });
  const desktop = exposed.workbuddyDesktop;
  assert.equal(desktop.configDir, dataDir);
  const filePath = path.join(desktop.configDir, "logs", "session.jsonl");
  await bridge.daemon("io:appendRecord", { filePath, jsonLine: '{"message":"BRIDGE_RECORD"}\n' });
  assert.equal(await fs.readFile(filePath, "utf8"), '{"message":"BRIDGE_RECORD"}\n');
  bridge.cleanup();
});

test('local IPC errors preserve actionable reasons without exposing the Electron transport prefix',async()=>{
 let message="Error invoking remote method 'wb-local:daemon': Error: Model unavailable";
 const bridge=installRendererBridge({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{on(){},removeListener(){},async invoke(){const e=Error(message);e.code='MODEL_UNAVAILABLE';throw e;}},window:{addEventListener(){},removeEventListener(){},localStorage:{getItem(){return null;},setItem(){}}}});
 await assert.rejects(bridge.daemon('test'),e=>e.message==='Model unavailable'&&e.code==='MODEL_UNAVAILABLE');
 message='Ordinary error with Error: meaningful text';
 await assert.rejects(bridge.daemon('test'),e=>e.message===message);
});
