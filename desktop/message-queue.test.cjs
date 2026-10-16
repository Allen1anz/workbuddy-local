const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");

test("queue concurrent edits persist content, order and pause state across dispatcher recreation", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-queue-regression-"));
  const server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await (await fetch(origin + "/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Queue regression" }),
    })).json();
    const events = [];
    const options = { origin, dataDir, emit: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }) };
    const dispatch = createDispatcher(options);
    const secondDispatcher = createDispatcher(options);
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? secondDispatcher : dispatch)("session:enqueueMessage", [session.id, [{ type: "text", text: `queued ${i}` }]])));
    const initial = await dispatch("session:getMessageQueue", [session.id]);
    assert.equal(initial.items.length, 8);
    assert.equal(initial.version, 8);
    assert.equal(events.length, 8);
    assert.equal(events[7].channel, `session:event:${session.id}`);
    assert.equal(events[7].payload.update.sessionUpdate, "session_info_update");
    assert.deepEqual(events[7].payload.update._meta["codebuddy.ai/message_queue_update"], initial);
    const last = initial.items.at(-1);
    const reordered = await dispatch("session:reorderQueue", [session.id, [last.id, last.id, "unknown"]]);
    assert.equal(reordered.items[0].id, last.id);
    assert.equal(reordered.items.length, 8);
    assert.deepEqual(reordered.items.map((item) => item.order), [0, 1, 2, 3, 4, 5, 6, 7]);
    await Promise.all([
      dispatch("session:pauseQueue", [session.id, "editing"]),
      dispatch("session:popQueueItemForEdit", [session.id, last.id]).then((result) => {
        assert.deepEqual(result.item.contentBlocks, last.contentBlocks);
        assert.equal(result.queue.items.length, 7);
      }),
    ]);
    const reopened = createDispatcher(options);
    const saved = await reopened("session:getMessageQueue", [session.id]);
    assert.equal(saved.items.length, 7);
    assert.equal(saved.runtime.paused, true);
    assert.equal(saved.runtime.pauseReason, "editing");
    const blocked = await reopened("session:activateQueue", [session.id]);
    assert.equal(blocked.item, undefined);
    assert.equal(blocked.queue.items.length, 7);
    const resumed = await reopened("session:resumeQueue", [session.id]);
    assert.equal(resumed.runtime.paused, false);
    assert.equal(resumed.runtime.pauseReason, undefined);
    await assert.rejects(reopened("session:reorderQueue", [session.id, "invalid"]));
    assert.equal((await reopened("session:getMessageQueue", [session.id])).version, resumed.version);
    assert.equal(events.at(-1).payload.update._meta["codebuddy.ai/message_queue_update"].version, resumed.version);
    const priority = resumed.items.at(-1);
    const immediate = await reopened("session:sendQueueItemNow", [session.id, priority.id]);
    assert.equal(immediate.item, undefined);
    assert.equal(immediate.queue.items.at(-1).status, "sending");
    const next = await reopened("session:activateQueue", [session.id]);
    assert.equal(next.item.id, priority.id);
    assert.equal(next.queue.items.length, 6);
    assert.equal(next.queue.runtime.immediateItemId, undefined);
    assert.equal(next.queue.runtime.activated, true);
    const restoredSnapshot = structuredClone(initial);
    assert.equal(await reopened("session:saveMessageQueue", [restoredSnapshot]), undefined);
    restoredSnapshot.items[0].contentBlocks[0].text = "caller mutation";
    const restored = await createDispatcher(options)("session:getMessageQueue", [session.id]);
    assert.deepEqual(restored, initial);
    const duplicate = structuredClone(restored);
    duplicate.items.push(duplicate.items[0]);
    await assert.rejects(reopened("session:saveMessageQueue", [duplicate]), /duplicate/);
    assert.deepEqual(await reopened("session:getMessageQueue", [session.id]), initial);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
