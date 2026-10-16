const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDispatcher } = require("./dispatcher.cjs");
test("memory preferences persist without overwriting content and failed saves roll back", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-memory-settings-"));
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = { origin: "http://127.0.0.1:" + server.address().port, dataDir };
    const dispatch = createDispatcher(options);
    await dispatch("memory:importContent", [{ content: "Saved memory proof" }]);
    await dispatch("config:set", ["memory", { generateMemoryEnabled: false, localMemoryEnabled: true }]);
    assert.equal((await dispatch("memory:getProfile")).generateMemoryEnabled, false);
    const result = await dispatch("memory:saveSettings", [{ generateMemoryEnabled: true, localMemoryEnabled: false }]);
    assert.equal(result.runtimeApplied, false);
    const reopened = createDispatcher(options);
    const baseline = await reopened("memory:getProfile");
    assert.equal(baseline.generateMemoryEnabled, true);
    assert.equal(baseline.localMemoryEnabled, false);
    assert.equal(baseline.memoryBlock, "Saved memory proof");
    assert.equal(await reopened("config:get", ["generateMemoryEnabled"]), true);
    assert.equal(await reopened("config:get", ["localMemoryEnabled"]), false);
    const suggestion = await reopened("memory:submitSuggestion", [{ suggestion: "Change memory", currentMemory: baseline.memoryBlock }]);
    assert.equal(suggestion.accepted, false);
    assert.deepEqual(await reopened("memory:getProfile"), baseline);
    for (const invalid of [null, [], { memoryBlock: "Overwritten" }, { generateMemoryEnabled: "true" }]) {
      await assert.rejects(reopened("memory:saveSettings", [invalid]));
      assert.deepEqual(await reopened("memory:getProfile"), baseline);
    }
    const filename = path.join(dataDir, "desktop-settings.json");
    await fs.rename(filename, filename + ".saved"); await fs.mkdir(filename);
    await assert.rejects(reopened("memory:saveSettings", [{ localMemoryEnabled: true }]));
    assert.deepEqual(await reopened("memory:getProfile"), baseline);
    assert.equal(await reopened("config:get", ["generateMemoryEnabled"]), true);
    assert.equal(await reopened("config:get", ["localMemoryEnabled"]), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
