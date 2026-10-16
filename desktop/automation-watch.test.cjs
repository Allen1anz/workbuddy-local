const test = require("node:test"),
  assert = require("node:assert/strict");
const { createAutomationWatch } = require("./automation-watch.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("automation watch emits state changes, ignores timestamp-only updates and recovers after errors", async () => {
  let status = "running",
    time = 1,
    fail = false;
  const emitted = [],
    errors = [];
  const watch = createAutomationWatch({
    getSnapshot: async () => {
      if (fail) throw Error("temporary");
      return {
        automations: [],
        inbox: [{ id: "run", status }],
        runtimeState: {},
        updatedAt: time++,
      };
    },
    publish: (value) => emitted.push(value),
    onError: (error) => errors.push(error.message),
    schedule: () => ({ unref() {} }),
    unschedule() {},
  });
  watch.start();
  await settle();
  assert.equal(emitted.length, 1);
  await watch.tick();
  assert.equal(emitted.length, 1);
  status = "completed";
  await watch.tick();
  assert.equal(emitted[1].inbox[0].status, "completed");
  fail = true;
  await watch.tick();
  assert.deepEqual(errors, ["temporary"]);
  fail = false;
  status = "archived";
  await watch.tick();
  assert.equal(emitted[2].inbox[0].status, "archived");
  watch.stop();
});
test("automation watch does not overlap requests or publish after shutdown", async () => {
  let resolve,
    calls = 0,
    cleared = 0;
  const emitted = [];
  const watch = createAutomationWatch({
    getSnapshot: () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
    publish: (value) => emitted.push(value),
    schedule: () => ({ unref() {} }),
    unschedule() {
      cleared++;
    },
  });
  watch.start();
  await watch.tick();
  assert.equal(calls, 1);
  watch.stop();
  resolve({ automations: [], inbox: [], runtimeState: {} });
  await settle();
  assert.equal(emitted.length, 0);
  assert.equal(cleared, 1);
});

test("MCP snapshot signature emits changed server and tool state without duplicate refresh or events after stop", async () => {
  let servers = [{ name: "proof", enabled: true, tools: [{ name: "read", enabled: true }] }];
  const events = [];
  const watch = createAutomationWatch({
    getSnapshot: async () => servers,
    getSignature: JSON.stringify,
    publish: async (value) => events.push({ type: "mcpServerChange", servers: value }),
    schedule: () => ({ unref() {} }),
    unschedule: () => {},
  });
  watch.start();
  await settle();
  assert.equal(events.length, 1);
  await watch.tick();
  assert.equal(events.length, 1);
  servers = [{ name: "proof", enabled: true, tools: [{ name: "read", enabled: false }] }];
  await watch.tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].servers[0].tools[0].enabled, false);
  watch.stop();
  servers = [];
  await watch.tick();
  assert.equal(events.length, 2);
});
