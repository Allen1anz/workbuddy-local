import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
import { runDshTurn } from "../tools/dsh-runtime.mjs";
const repository = process.env.DSH_REPOSITORY || "/nonexistent/dsh";
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
const stop = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const stream = (res, delta, reason = "stop") => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: reason }] }]) res.write("data: " + JSON.stringify(chunk) + "\n\n");
  res.end("data: [DONE]\n\n");
};
test("real DSH profile preserves approvals, executes registered tools and resumes persisted history", { timeout: 45000 }, async t => {
  try { await fs.access(path.join(repository, "apps/cli/lib/bin.js")); } catch { return t.skip("Local DSH checkout unavailable"); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-dsh-integration-"));
  const dataDir = path.join(dir, "data");
  const workspace = path.join(dir, "workspace"); await fs.mkdir(workspace);
  const bodies = [];
  const model = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (bodies.length === 1) {
      assert(body.tools.some(tool => tool.function.name === "workspace_write"));
      assert(!body.tools.some(tool => ["bash", "persistent_bash"].includes(tool.function.name)));
      stream(res, { role: "assistant", tool_calls: [{ index: 0, id: "write-proof", type: "function", function: { name: "workspace_write", arguments: JSON.stringify({ path: "proof.txt", content: "DSH_APPROVED_PROOF" }) } }] }, "tool_calls");
    } else stream(res, { role: "assistant", content: bodies.length === 2 ? "DSH_TOOL_DONE" : "DSH_RESUMED" });
  });
  const modelURL = await listen(model), app = createAppServer({ dataDir }), url = await listen(app);
  const api = (route, method = "GET", body) => fetch(url + "/api" + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    await fs.writeFile(path.join(dataDir, "dsh-runtime.json"), JSON.stringify({ enabled: true, repository }));
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "dsh-proof", workspace });
    const session = await (await api("/sessions", "POST", { workspace })).json();
    const response = await api("/sessions/" + session.id + "/chat", "POST", { message: "Write proof.txt", mode: "craft" });
    const pendingStream = response.text();
    let approvals = [];
    for (let i = 0; i < 300; i++) { approvals = await (await api("/approvals")).json(); if (approvals.length) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(approvals.length, 1);
    await assert.rejects(fs.access(path.join(workspace, "proof.txt")));
    await api("/approvals/" + approvals[0].id, "POST", { decision: "approve" });
    const first = await pendingStream;
    assert(first.includes("DSH_TOOL_DONE"), first);
    assert.equal(await fs.readFile(path.join(workspace, "proof.txt"), "utf8"), "DSH_APPROVED_PROOF");
    const second = await (await api("/sessions/" + session.id + "/chat", "POST", { message: "Continue", mode: "craft" })).text();
    assert(second.includes("DSH_RESUMED"), second);
    assert(bodies.at(-1).messages.some(message => message.role === "tool"));
    assert(bodies.at(-1).messages.some(message => message.role === "assistant" && message.content === "DSH_TOOL_DONE"));
    assert.equal((await (await api("/sessions/" + session.id)).json()).runtimeEngine, "dsh");
  } finally { await stop(app); await stop(model); }
});

test("cancellation closes the real DSH runtime and its outstanding model request", { timeout: 15000 }, async t => {
  try { await fs.access(path.join(repository, "apps/cli/lib/bin.js")); } catch { return t.skip("Local DSH checkout unavailable"); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-dsh-cancel-"));
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  let responseClosed;
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const model = http.createServer((req, res) => {
    req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders();
    res.on("close", responseClosed); requestStarted();
  });
  const url = await listen(model);
  try {
    const run = runDshTurn({ repository, dataDir: dir, sessionId: "cancel-proof", workspace: dir,
      model: "local-test", baseURL: url + "/v1", system: "test", message: "wait", signal: controller.signal });
    const rejected = assert.rejects(run);
    await started;
    controller.abort();
    await rejected;
    await closed;
  } finally { controller.abort(); await stop(model); }
});

test("selected skill loader resolves through product skill policy in the real DSH loop", { timeout: 15000 }, async t => {
  try { await fs.access(path.join(repository, "apps/cli/lib/bin.js")); } catch { return t.skip("Local DSH checkout unavailable"); }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-dsh-skill-"));
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (++calls === 1) {
      assert(body.tools.some(tool => tool.function.name === "dsh-selected-proof"));
      stream(res, { role: "assistant", tool_calls: [{ index: 0, id: "skill-proof", type: "function", function: { name: "dsh-selected-proof", arguments: "{}" } }] }, "tool_calls");
    } else {
      assert(JSON.stringify(body.messages.at(-1)).includes("SELECTED_SKILL_BODY_PROOF"));
      stream(res, { role: "assistant", content: "DSH_SKILL_OK" });
    }
  });
  const modelURL = await listen(model), app = createAppServer({ dataDir }), url = await listen(app);
  const api = (route, method = "GET", body) => fetch(url + "/api" + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    await fs.writeFile(path.join(dataDir, "dsh-runtime.json"), JSON.stringify({ enabled: true, repository }));
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "dsh-proof" });
    const skill = await (await api("/skills", "POST", { name: "dsh-selected-proof", content: "SELECTED_SKILL_BODY_PROOF", enabled: true })).json();
    const session = await (await api("/sessions", "POST", {})).json();
    const result = await (await api("/sessions/" + session.id + "/chat", "POST", { message: "Use selected skill", skillIds: [skill.id] })).text();
    assert(result.includes("DSH_SKILL_OK"), result);
    assert(result.includes('"name":"skill_invoke"'), result);
    assert.equal(calls, 2);
  } finally { await stop(app); await stop(model); }
});
