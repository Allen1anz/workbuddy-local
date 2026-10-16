const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");
test("local nickname persists and failed or invalid writes preserve account and emit no success", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-account-"));
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const events = [];
  const options = { origin: "http://127.0.0.1:" + server.address().port, dataDir, emit: (...args) => events.push(args) };
  try {
    const dispatch = createDispatcher(options), before = await dispatch("auth:getAccount");
    await dispatch("auth:updateAccountNickname", ["Local verification"]);
    const reopened = createDispatcher(options), account = await reopened("auth:getAccount");
    assert.equal(account.nickname, "Local verification");
    assert.equal(account.uid, before.uid);
    for (const invalid of [null, {}, 12, " ", "x".repeat(21), "name\ninside"]) {
      await assert.rejects(reopened("auth:updateAccountNickname", [invalid]));
      assert.deepEqual(await reopened("auth:getAccount"), account);
    }
    const count = events.length, filename = path.join(dataDir, "desktop-settings.json");
    await fs.rename(filename, filename + ".saved");
    await fs.mkdir(filename);
    await assert.rejects(reopened("auth:updateAccountNickname", ["Failed write"]));
    assert.deepEqual(await reopened("auth:getAccount"), account);
    assert.equal(events.length, count);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
