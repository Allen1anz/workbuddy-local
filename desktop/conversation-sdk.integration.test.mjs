import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createAppServer } from "../server/app.mjs";
const { createDispatcher } = createRequire(import.meta.url)("./dispatcher.cjs");
const { conversationInfo, textRequests, requestEntries } = createRequire(import.meta.url)("./conversation-sdk.cjs");

test("new conversation snapshots and scoped lists preserve the existing local session", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-conversation-sdk-"));
  const dataDir = path.join(root, "data"), cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const emitted = [];
  const dispatch = createDispatcher({ origin, dataDir, emit: (...args) => emitted.push(args) });
  const created = await dispatch("wb:conversations:create", [{ title: "SDK real local record", cwd, model: "custom-local:test-model", mode: "craft", skillIds: ["test-skill"] }]);
  assert.ok(created.info.id);
  assert.equal(created.info.title, "SDK real local record");
  assert.equal(created.info.space.cwd, cwd);
  assert.equal(created.info.transport, "local");
  assert.ok(Number.isFinite(created.info.createdAt));
  assert.equal(created.configManager.model, "custom-local:test-model");
  const legacy = await dispatch("session:get", [created.info.id]);
  assert.equal(legacy.model, "test-model");
  assert.deepEqual(legacy.skillIds, ["test-skill"]);
  assert.deepEqual(await dispatch("wb:conversations:get", [created.info.id]), created);
  const listed = await dispatch("wb:conversations:listScope", ["local", { size: 1 }]);
  assert.equal(listed.items[0].id, created.info.id);
  assert.equal(listed.page.size, 1);
  assert.equal((await dispatch("wb:conversations:list", [{ transport: "cloud" }])).items.length, 0);
  assert.equal((await dispatch("wb:conversations:listScope", ["cloud"])).items.length, 0);
  assert.equal((await dispatch("wb:conversations:listScope", ["project"])).items.length, 0);
  await dispatch("wb:conversations:ensureList", ["local", { traceId: "test-trace" }]);
  const progress = emitted.find(([channel]) => channel === "wb:conversations:listProgress");
  assert.equal(progress[1].space, "local");
  assert.equal(progress[1].traceId, "test-trace");
  assert.equal(progress[1].list.items[0].id, created.info.id);
  assert.deepEqual(await dispatch("wb:conversations:listPinned"), []);
  assert.equal(conversationInfo({ id: "test", status: "running" }).state, "working");
  assert.equal(conversationInfo({ id: "test", status: "pending" }).state, "pending");
  assert.equal(conversationInfo({ id: "test", status: "cancelled" }).state, "terminated");
  const history = await dispatch("wb:conversations:requestEntries", [created.info.id, { byteLength: 1024 }]);
  assert.deepEqual(history, { requests: [], entries: [], totalRequests: 0, hasOlder: false, historyReady: true, historyKnownEmpty: true });
  assert.deepEqual(await dispatch("wb:conversations:requests", [created.info.id]), { items: [], total: 0, page: 1 });
  assert.equal(await dispatch("wb:conversations:getPendingInfo", [created.info.id]), undefined);
  assert.deepEqual(await dispatch("wb:conversations:queueItems", [created.info.id]), []);
  assert.deepEqual(await dispatch("wb:conversations:childAgentSnapshots", [created.info.id]), []);
  assert.equal(await dispatch("wb:conversations:getPluginRecommendation", [created.info.id]), undefined);
  assert.equal(await dispatch("wb:conversations:getCloudServiceConfirmation", [created.info.id]), undefined);
  await dispatch("wb:conversations:configSetSandboxMode", [created.info.id, false]);
  await assert.rejects(dispatch("wb:conversations:configSetSandboxMode", [created.info.id, true]), /尚未接入/);
});

test("plain text history preserves turn identity, content and cursor pages without hiding tool events", () => {
  const messages = [
    { id: "11111111-1111-4111-8111-111111111111", role: "user", content: "第一问", createdAt: "2026-10-16T00:00:00Z" },
    { id: "answer-1", role: "assistant", content: "第一答", createdAt: "2026-10-16T00:00:01Z" },
    { id: "22222222-2222-4222-8222-222222222222", role: "user", content: "第二问", createdAt: "2026-10-16T00:00:02Z" },
    { id: "answer-2", role: "assistant", content: "第二答", createdAt: "2026-10-16T00:00:03Z" },
  ];
  const requests = textRequests({ status: "completed" }, messages);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, "11111111111141118111111111111111");
  assert.equal(requests[0].userMessage.content[0].text, "第一问");
  assert.equal(requests[0].assistantMessage.content[0].text, "第一答");
  assert.equal(requests[1].state, "completed");
  const latest = requestEntries(requests, { byteLength: 1 });
  assert.equal(latest.requests.length, 1);
  assert.equal(latest.hasOlder, true);
  assert.deepEqual(latest.entries.map(entry => entry.role), ["user", "assistant"]);
  const older = requestEntries(requests, { beforeRequestId: latest.requests[0].id });
  assert.equal(older.requests[0].id, requests[0].id);
  assert.equal(older.hasOlder, false);
  assert.throws(() => requestEntries(requests, { beforeRequestId: "missing" }), /cursor/);
  assert.equal(textRequests({ status: "running" }, messages)[1].state, "streaming");
  assert.throws(() => textRequests({}, messages, [{ event: "tool" }]), /工具历史/);
});
