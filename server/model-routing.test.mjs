import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + s.address().port)));
test("session model selection uses its saved endpoint credentials and tool capability", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-model-routing-"));
  let globalCalls = 0,
    selectedCalls = 0;
  const global = http.createServer((req, res) => {
    globalCalls++;
    res.end("{}");
  });
  const selected = http.createServer(async (req, res) => {
    selectedCalls++;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer selected-test-key");
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    assert.equal(body.model, "selected-model");
    assert.equal(body.tools, undefined);
    assert(!body.messages[0].content.includes("Available skill catalog"));
    assert(body.messages[0].content.includes("tool execution disabled"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "selected provider" } }],
      }),
    );
  });
  const globalURL = await listen(global),
    selectedURL = await listen(selected),
    app = createAppServer({ dataDir: dir }),
    url = await listen(app);
  const api = async (route, method = "GET", body) =>
    fetch(url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await api("/config", "PUT", {
      baseURL: globalURL + "/v1",
      model: "global-model",
      apiKey: "global-test-key",
    });
    await fs.writeFile(
      path.join(dir, "desktop-settings.json"),
      JSON.stringify({
        models: [
          {
            id: "selected-model",
            url: selectedURL + "/v1/chat/completions",
            apiKey: "selected-test-key",
            supportsToolCall: false,
          },
        ],
      }),
    );
    const s = await (
      await api("/sessions", "POST", { title: "routing", model: "selected-model" })
    ).json();
    const stream = await (
      await api("/sessions/" + s.id + "/chat", "POST", { message: "test", mode: "ask" })
    ).text();
    assert(stream.includes("selected provider"));
    assert.equal(selectedCalls, 1);
    assert.equal(globalCalls, 0);
    const config = await (await api("/config")).json();
    assert.equal(config.baseURL, globalURL + "/v1");
    assert.equal(config.model, "global-model");
    assert.equal(config.apiKey, undefined);
    await fs.writeFile(path.join(dir, "desktop-settings.json"), JSON.stringify({ models: [] }));
    const removed = await (
      await api("/sessions/" + s.id + "/chat", "POST", { message: "test again", mode: "ask" })
    ).text();
    assert(removed.includes("Selected model is no longer configured"));
    assert.equal(selectedCalls, 1);
    assert.equal(globalCalls, 0);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => global.close(r));
    await new Promise((r) => selected.close(r));
  }
});

test("tool-disabled model cannot execute unsolicited returned tool calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-no-model-tools-"));
  const model = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "unexpected",
                  type: "function",
                  function: {
                    name: "workspace_read",
                    arguments: JSON.stringify({ path: "proof.txt" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: dir }),
    url = await listen(app);
  const api = async (route, method = "GET", body) =>
    fetch(url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await api("/config", "PUT", {
      baseURL: modelURL + "/v1",
      model: "text-only",
      supportsTools: false,
      workspace: dir,
    });
    await fs.writeFile(path.join(dir, "proof.txt"), "DO_NOT_READ");
    const s = await (await api("/sessions", "POST", { title: "text only" })).json();
    const stream = await (
      await api("/sessions/" + s.id + "/chat", "POST", { message: "test", mode: "ask" })
    ).text();
    assert(stream.includes("returned tool calls were not executed"));
    assert(!stream.includes("DO_NOT_READ"));
    const events = await (await api("/sessions/" + s.id + "/events")).json();
    assert.equal(
      events.filter((e) => ["tool", "tool_result", "approval"].includes(e.event)).length,
      0,
    );
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
