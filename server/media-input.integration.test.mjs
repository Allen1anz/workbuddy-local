import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + s.address().port)));
test("image and audio blocks reach selected model", async () => {
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
    const parts = body.messages.at(-1).content;
    assert.equal(parts[0].text, "test");
    assert.equal(parts[1].type, "image_url");
    assert(parts[1].image_url.url.startsWith("data:image/png;base64,"));
    assert.deepEqual(parts[2], {type:"input_audio",input_audio:{data:Buffer.from("RIFF0000WAVEtest").toString("base64"),format:"wav"}});
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
      await api("/sessions/" + s.id + "/chat", "POST", { message: "test", mode: "ask", media: [{type:"image",mimeType:"image/png",data:Buffer.from([137,80,78,71,13,10,26,10]).toString("base64")},{type:"audio",mimeType:"audio/wav",data:Buffer.from("RIFF0000WAVEtest").toString("base64")}] })
    ).text();
    assert(stream.includes("selected provider"));
    const history = await (await api("/sessions/" + s.id + "/messages")).json();
    assert.equal(history[0].media.length, 2);
    assert.equal(history[0].content, "test");
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
