const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLocalModelManager } = require("./local-model.cjs");
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-mlx-"));
  const python = path.join(dir, "python"),
    modelPath = path.join(dir, "model");
  await fs.writeFile(python, "#!/bin/sh\n", { mode: 0o700 });
  await fs.mkdir(modelPath);
  await fs.writeFile(path.join(modelPath, "config.json"), "{}");
  return {
    dataDir: path.join(dir, "data"),
    python,
    modelPath: await fs.realpath(modelPath),
    enabled: true,
    autostart: true,
  };
}
const response = (model) => ({ ok: true, json: async () => ({ data: [{ id: model }] }) });
test("disabled by default and explicit configuration persists", async () => {
  const f = await fixture();
  const m = createLocalModelManager({
    dataDir: f.dataDir,
    spawnProcess: () => {
      throw Error("must not spawn");
    },
  });
  assert.equal((await m.autostart()).status, "disabled");
  await m.configure(f);
  const n = createLocalModelManager({ dataDir: f.dataDir });
  assert.equal((await n.getConfiguration()).modelPath, f.modelPath);
  assert.equal((await fs.stat(path.join(f.dataDir, "local-model.json"))).mode & 0o777, 0o600);
  await assert.rejects(m.configure({ port: 80 }), /port/);
});
test("matching external service is reused and never terminated", async () => {
  const f = await fixture();
  const m = createLocalModelManager({
    dataDir: f.dataDir,
    request: async () => response(f.modelPath),
    spawnProcess: () => {
      throw Error("must not spawn");
    },
  });
  await m.configure(f);
  assert.equal((await m.start()).managed, false);
  assert.equal((await m.stop()).notStoppedReason, "Service is externally managed");
  assert.equal(m.ownsProcess(), false);
});
test("occupied service with wrong model is rejected", async () => {
  const f = await fixture();
  const m = createLocalModelManager({
    dataDir: f.dataDir,
    request: async () => response("wrong"),
    spawnProcess: () => {
      throw Error("must not spawn");
    },
  });
  await m.configure(f);
  await assert.rejects(m.start(), /occupied/);
});
test("owned process receives offline loopback args and stops", async () => {
  const f = await fixture();
  let calls = 0,
    spawned,
    killed;
  const proc = new EventEmitter();
  proc.pid = 2147483646;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (signal) => {
    killed = signal;
    queueMicrotask(() => proc.emit("close", 0));
  };
  const m = createLocalModelManager({
    dataDir: f.dataDir,
    pollInterval: 1,
    request: async () => {
      if (!calls++) throw Error("refused");
      return response(f.modelPath);
    },
    spawnProcess: (python, args, options) => {
      spawned = { python, args, options };
      return proc;
    },
  });
  await m.configure(f);
  assert.equal((await m.start()).managed, true);
  assert.equal(spawned.python, f.python);
  assert.equal(spawned.options.env.HF_HUB_OFFLINE, "1");
  assert.equal(spawned.options.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(spawned.options.env.HF_TOKEN, undefined);
  assert.equal(spawned.args[spawned.args.indexOf("--host") + 1], "127.0.0.1");
  assert.equal(spawned.args[spawned.args.indexOf("--model") + 1], f.modelPath);
  await m.stop();
  assert.equal(killed, "SIGTERM");
  assert.equal(m.ownsProcess(), false);
});
