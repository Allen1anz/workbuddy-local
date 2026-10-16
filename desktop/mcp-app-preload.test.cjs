const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const vm = require("node:vm");
const path = require("node:path");

test("shipped MCP Guest preload routes outbound messages once and delivers host replies without bouncing", async () => {
  const source = await fs.readFile(path.join(__dirname, "../tools/mcp-app-preload.cjs"), "utf8");
  const listeners = [], sent = [], exposed = {}, ipc = {};
  const window = {
    location: { origin: "http://127.0.0.1:12345" },
    addEventListener(type, callback, options) { listeners.push({ type, callback, options }); },
    dispatchEvent(event) {
      for (const listener of listeners.filter((item) => item.type === event.type)) {
        listener.callback(event);
        if (event.stopped) break;
      }
    },
  };
  class MessageEvent {
    constructor(type, values) { this.type = type; Object.assign(this, values); }
    stopImmediatePropagation() { this.stopped = true; }
  }
  const context = {
    window, MessageEvent, setTimeout, clearTimeout,
    console: { info() {}, error(...args) { throw Error(args.join(" ")); } },
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } },
        ipcRenderer: {
          sendToHost(channel, data) { sent.push({ channel, data }); },
          on(channel, callback) { ipc[channel] = callback; },
        },
      };
    },
  };
  vm.runInNewContext(source, context, { timeout: 1000 });
  assert.equal(listeners[0].options.capture, true);
  const outbound = { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "ui://proof" } };
  const outgoing = new MessageEvent("message", { data: outbound, source: window });
  window.dispatchEvent(outgoing);
  assert.equal(outgoing.stopped, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "mcp-app-client-message");
  assert.equal(sent[0].data, outbound);
  let delivered;
  window.addEventListener("message", (event) => { delivered = event; });
  const reply = { jsonrpc: "2.0", id: 7, result: { contents: [] } };
  ipc["mcp-app-host-message"]({}, reply);
  assert.equal(delivered.data, reply);
  assert.equal(delivered.source, window);
  assert.equal(sent.length, 1);
  const ordinary = new MessageEvent("message", { data: { analytics: true } });
  window.dispatchEvent(ordinary);
  assert.equal(ordinary.stopped, undefined);
  assert.equal(sent.length, 1);
  const pending = exposed.__mcpHostTestApi.getWBCurrentSessionId();
  const request = sent.at(-1).data;
  assert.equal(request.method, "host/getWBCurrentSessionId");
  ipc["mcp-app-host-message"]({}, { jsonrpc: "2.0", id: request.id, result: { sessionId: "actual-session" } });
  assert.equal((await pending).sessionId, "actual-session");
});
