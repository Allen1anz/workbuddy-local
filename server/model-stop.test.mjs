import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + s.address().port)));
test("truncated JSON and SSE replies remain incomplete and never execute tool calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-model-stop-"));
  let streaming = false,
    tailWithoutNewline = false;
  const model = http.createServer((req, res) => {
    const message = {
      content: "Partial answer",
      tool_calls: [
        {
          id: "write",
          type: "function",
          function: {
            name: "workspace_write",
            arguments: JSON.stringify({ path: "must-not-exist.txt", content: "bad" }),
          },
        },
      ],
    };
    res.writeHead(200, { "Content-Type": streaming ? "text/event-stream" : "application/json" });
    res.end(
      streaming
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: message.content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}${tailWithoutNewline ? "" : "\n\ndata: [DONE]\n\n"}`
        : JSON.stringify({ choices: [{ message, finish_reason: "length" }] }),
    );
  });
  const modelBase = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "data") }),
    base = await listen(app);
  const api = async (route, method = "GET", body) =>
    (
      await fetch(base + "/api" + route, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json();
  try {
    await api("/config", "PUT", { baseURL: modelBase + "/v1", model: "fixture", workspace: dir });
    for (const [useStream, noNewline] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      streaming = useStream;
      tailWithoutNewline = noNewline;
      const session = await api("/sessions", "POST", {});
      const response = await fetch(base + "/api/sessions/" + session.id + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test", mode: "craft" }),
      });
      const output = await response.text();
      assert(output.includes("回答未完成"));
      assert(!output.includes("event: done"));
      assert(!output.includes("event: approval"));
      const saved = await api("/sessions/" + session.id + "/messages");
      assert(
        saved.some(
          (m) =>
            m.role === "assistant" &&
            m.content.includes("[回答未完成]") &&
            m.content.includes("Partial answer"),
        ),
      );
    }
    assert.equal((await api("/approvals")).length, 0);
    await assert.rejects(fs.stat(path.join(dir, "must-not-exist.txt")), { code: "ENOENT" });
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
