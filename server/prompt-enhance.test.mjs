import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
test("prompt enhancement uses selected credentials without tools or session writes and preserves typed failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-enhance-"));
  let calls = 0, reply = "整理已有资料，列出问题和建议。";
  const provider = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer selected-test-key");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "selected-model");
    assert.equal(body.tools, undefined);
    assert.equal(body.stream, false);
    assert.equal(body.messages[1].content, "帮我整理资料");
    assert(body.messages[0].content.includes("Do not answer or execute"));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  const endpoint = await listen(provider), app = createAppServer({ dataDir: dir }), origin = await listen(app);
  const api = async (route, method = "GET", body) => (await fetch(origin + "/api" + route, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  })).json();
  try {
    await api("/config", "PUT", { baseURL: endpoint + "/wrong", model: "default-model" });
    await fs.writeFile(path.join(dir, "desktop-settings.json"), JSON.stringify({ models: [{ id: "selected-model", url: endpoint + "/v1/chat/completions", apiKey: "selected-test-key" }] }));
    const session = await api("/sessions", "POST", { title: "enhance", model: "selected-model" });
    assert.deepEqual(await api("/prompt/enhance", "POST", { text: "帮我整理资料", sessionId: session.id }), { success: true, text: reply });
    assert.deepEqual(await api("/sessions/" + session.id + "/messages"), []);
    assert.equal((await api("/config")).model, "default-model");
    assert.equal((await api("/prompt/enhance", "POST", { text: " " })).code, "invalid_input");
    assert.equal((await api("/prompt/enhance", "POST", { text: "帮我整理资料", model: "removed-model" })).success, false);
    assert.equal(calls, 1);
    reply = " ";
    const empty = await api("/prompt/enhance", "POST", { text: "帮我整理资料", model: "custom-local:selected-model" });
    assert.equal(empty.code, "llm_error");
    assert.equal(empty.success, false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});
