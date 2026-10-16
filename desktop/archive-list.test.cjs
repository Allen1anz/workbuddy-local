const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");
test("archived task list honors status filter and returns restored task to normal list", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-archive-list-"));
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const dispatch = createDispatcher({ origin, dataDir });
  const create = async title => (await fetch(origin + "/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) })).json();
  try {
    const normal = await create("normal"), archived = await create("archived");
    await dispatch("session:archive", [{ sessionId: archived.id }]);
    const options = { filters: [{ field: "status", value: "archived" }], sort: { orderBy: "updatedAt", order: "desc" } };
    assert.deepEqual((await dispatch("session:list", [options])).agents.map(item => item.id), [archived.id]);
    assert.equal((await dispatch("session:list", [{}])).agents.length, 2);
    await dispatch("session:updateStatus", [{ sessionId: archived.id, status: "completed" }]);
    assert.deepEqual((await dispatch("session:list", [options])).agents, []);
    assert((await dispatch("session:list", [{}])).agents.some(item => item.id === normal.id));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
