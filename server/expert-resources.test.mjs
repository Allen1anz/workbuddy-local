import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + s.address().port)));
test("local expert model tools read package references and reject outside paths", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-refs-")),
    root = path.join(dir, "expert-config/plugins/marketplaces/my-experts/plugins/author");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.mkdir(path.join(root, "references"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({ name: "author", agentName: "author", expertType: "agent" }),
  );
  await fs.writeFile(path.join(root, "agents/author.md"), "Use references/proof.txt");
  await fs.writeFile(path.join(root, "references/proof.txt"), "EXPERT_REFERENCE_PROOF");
  await fs.writeFile(path.join(path.dirname(root), "outside.txt"), "OUTSIDE_PRIVATE_MARKER");
  const calls = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push(body);
    const message =
      calls.length === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: ["references/proof.txt", "../outside.txt"].map((p, i) => ({
              id: "read-" + i,
              type: "function",
              function: { name: "expert_resource_read", arguments: JSON.stringify({ path: p }) },
            })),
          }
        : { role: "assistant", content: "done" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const modelBase = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "data") }),
    base = await listen(app);
  const api = async (route, method = "GET", body) => {
    const r = await fetch(base + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.ok, true);
    return r.json();
  };
  try {
    await api("/config", "PUT", { baseURL: modelBase + "/v1", model: "fixture" });
    await api("/experts/custom-expert%3Aauthor", "PUT", { source: "local-expert-package" });
    const session = await api("/sessions", "POST", {});
    const response = await fetch(base + "/api/sessions/" + session.id + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "read references",
        expertId: "custom-expert:author",
        mode: "ask",
      }),
    });
    await response.text();
    assert(calls[0].messages[0].content.includes("expert_resource_read"));
    assert(calls[0].tools.some((t) => t.function.name === "expert_resource_read"));
    const results = calls[1].messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    assert(results[0].content.includes("EXPERT_REFERENCE_PROOF"));
    assert(results[1].content.includes("error"));
    assert(!results[1].content.includes("OUTSIDE_PRIVATE_MARKER"));
    assert.equal((await api("/approvals")).length, 0);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
