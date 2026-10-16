const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDispatcher } = require("./dispatcher.cjs");
test("saved workspace location survives reopening and applies only to newly generated directories", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "wb-workspace-settings-"));
  const dataDir = path.join(profile, "data"), root = path.join(profile, "selected");
  await fs.mkdir(root);
  const canonicalRoot = await fs.realpath(root);
  const options = { origin: "http://127.0.0.1:18723", dataDir, homeDir: profile };
  const dispatch = createDispatcher(options);
  const oldDirectory = await dispatch("workspace:generateDefaultCwd");
  await fs.writeFile(path.join(oldDirectory, "keep.txt"), "Existing workspace");
  assert.equal((await dispatch("window:saveDefaultWorkspacePath", [{ path: root }])).path, canonicalRoot);
  const reopened = createDispatcher(options);
  const generated = await reopened("workspace:generateDefaultCwd");
  assert.equal(path.dirname(generated), canonicalRoot);
  assert.equal(await fs.readFile(path.join(oldDirectory, "keep.txt"), "utf8"), "Existing workspace");
  const tildeGenerated = await reopened("workspace:generateDefaultCwd", [{ root: "~/WorkBuddy" }]);
  assert.equal(path.dirname(tildeGenerated), await fs.realpath(path.join(profile, "WorkBuddy")));
  const file = path.join(root, "file.txt"); await fs.writeFile(file, "Not a directory");
  for (const invalid of ["relative", dataDir, file]) {
    await assert.rejects(reopened("window:saveDefaultWorkspacePath", [{ path: invalid }]));
    assert.equal(await reopened("config:get", ["defaultWorkspacePath"]), canonicalRoot);
  }
  await assert.rejects(reopened("workspace:generateDefaultCwd", [{ root: dataDir }]));
});
test("new sessions use saved defaults while explicit and existing workspaces retain their locations", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "wb-workspace-session-"));
  const dataDir = path.join(profile, "data"), oldRoot = path.join(profile, "old"), newRoot = path.join(profile, "new");
  await fs.mkdir(oldRoot); await fs.mkdir(newRoot);
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const api = async (route, method = "GET", body) => {
    const response = await fetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.ok, true); return response.json();
  };
  try {
    await api("/config", "PUT", { workspace: oldRoot, model: "local" });
    const options = { origin, dataDir, homeDir: profile };
    const dispatch = createDispatcher(options);
    const existing = await dispatch("session:create", [{ cwd: oldRoot }]);
    await dispatch("window:saveDefaultWorkspacePath", [{ path: newRoot }]);
    const reopened = createDispatcher(options);
    const first = await reopened("session:create", [{}]);
    const second = await reopened("session:create", [{}]);
    const savedFirst = await api("/sessions/" + first.sessionId);
    const savedSecond = await api("/sessions/" + second.sessionId);
    assert.equal(path.dirname(savedFirst.workspace), await fs.realpath(newRoot));
    assert.notEqual(savedFirst.workspace, savedSecond.workspace);
    assert.equal((await api("/sessions/" + existing.sessionId)).workspace, oldRoot);
    const explicit = await reopened("session:create", [{ cwd: oldRoot }]);
    assert.equal((await api("/sessions/" + explicit.sessionId)).workspace, oldRoot);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
