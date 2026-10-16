import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createAppServer } from "./app.mjs";
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
test("memory corrections preserve revisions and reject stale, empty or concurrently changed results", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-memory-correction-"));
  let reply = "Project: product first. Preference: concise.", mutate, finishReason = "stop";
  const provider = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.tools, undefined);
    assert.equal(body.model, "test-model");
    assert(body.messages[0].content.includes("Preserve unrelated"));
    assert(body.messages[1].content.startsWith("Existing memory:\n"));
    assert(body.messages[1].content.includes("\n\nRequested correction:\n"));
    if (mutate) await mutate();
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: finishReason }] }));
  });
  const endpoint = await listen(provider), app = createAppServer({ dataDir: dir }), origin = await listen(app);
  const api = async (route, method = "GET", body) => (await fetch(origin + "/api" + route, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  })).json();
  const memory = async () => (await api("/memories")).map(item => item.content).join("\n\n");
  try {
    await api("/config", "PUT", { baseURL: endpoint + "/v1", model: "test-model" });
    await api("/memories", "POST", { content: "Preference: concise." });
    const target = await api("/memories", "POST", { content: "Project: runtime first." });
    const before = await api("/memories"), currentMemory = await memory();
    assert.equal((await api("/memory-profile/suggestion", "POST", { currentMemory: "stale", suggestion: "product first" })).accepted, false);
    assert.equal((await api("/memory-profile/suggestion", "POST", { currentMemory, suggestion: "product first" })).accepted, true);
    assert((await memory()).includes(reply));
    const db = new DatabaseSync(path.join(dir, "workbuddy.sqlite"));
    const revision = JSON.parse(db.prepare("SELECT data FROM entities WHERE kind='memoryRevisions'").get().data);
    assert.deepEqual(revision.memories, before);
    db.close();
    const saved = await memory();
    reply = " ";
    assert.equal((await api("/memory-profile/suggestion", "POST", { currentMemory: saved, suggestion: "add test" })).accepted, false);
    assert.equal(await memory(), saved);
    reply = "Truncated update";
    finishReason = "length";
    assert.equal((await api("/memory-profile/suggestion", "POST", { currentMemory: saved, suggestion: "add test" })).accepted, false);
    assert.equal(await memory(), saved);
    finishReason = "stop";
    reply = "Wrong overwrite";
    mutate = () => api("/memories/" + target.id, "PUT", { content: "Concurrent change" });
    const result = await api("/memory-profile/suggestion", "POST", { currentMemory: saved, suggestion: "another update" });
    assert.equal(result.accepted, false);
    assert(result.error.includes("changed during editing"));
    assert((await memory()).includes("Concurrent change"));
  } finally {
    await new Promise(resolve => app.close(resolve));
    await new Promise(resolve => provider.close(resolve));
  }
});
