import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "./app.mjs";

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

test("expert, selected skills and memories enter model context and persist across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "wb-resources-"));
  const dataDir = join(root, "data"),
    workspace = join(root, "workspace");
  await mkdir(workspace);
  const captured = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    captured.push(JSON.parse(raw));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "Fixture response" } }] }));
  });
  const modelURL = await listen(model);
  let app = createAppServer({ dataDir }),
    url = await listen(app);
  const request = async (route, method = "GET", body) => {
    const response = await fetch(url + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.headers.get("content-type").includes("text/event-stream")
      ? response.text()
      : response.json();
  };
  try {
    await request("/api/config", "PUT", {
      baseURL: modelURL + "/v1",
      model: "protocol-fixture",
      workspace,
    });
    const expert = await request("/api/experts", "POST", {
      name: "产品专家",
      systemPrompt: "EXPERT_CONTEXT_MARKER",
    });
    const skill = await request("/api/skills", "POST", {
      name: "复核方法",
      content: "SELECTED_SKILL_MARKER",
    });
    const unused = await request("/api/skills", "POST", {
      name: "未选技能",
      content: "UNSELECTED_SKILL_MARKER",
    });
    const memory = await request("/api/memories", "POST", {
      name: "偏好",
      content: "PERSISTENT_MEMORY_MARKER",
    });
    const session = await request("/api/sessions", "POST", {
      title: "资源验收", systemPrompt: "SESSION_PROMPT_MARKER",
    });
    const first = await request(`/api/sessions/${session.id}/chat`, "POST", {
      message: "Analyze fixture",
      mode: "ask",
      expertId: expert.id,
      skillIds: [skill.id],
    });
    assert.ok(first.includes("event: done"));
    const system = captured[0].messages[0].content;
    for (const marker of [
      "EXPERT_CONTEXT_MARKER",
      "SELECTED_SKILL_MARKER",
      "PERSISTENT_MEMORY_MARKER",
      "SESSION_PROMPT_MARKER",
    ])
      assert.ok(system.includes(marker));
    assert.equal(system.includes("UNSELECTED_SKILL_MARKER"), false);
    const savedSession = await request(`/api/sessions/${session.id}`);
    assert.equal(savedSession.expertId, expert.id);
    assert.deepEqual(savedSession.skillIds, [skill.id]);
    await new Promise((resolve) => app.close(resolve));
    app = createAppServer({ dataDir });
    url = await listen(app);
    assert.equal((await request("/api/experts"))[0].id, expert.id);
    assert.equal((await request("/api/memories"))[0].id, memory.id);
    assert.equal((await request("/api/skills")).length, 2);
    const next = await request(`/api/sessions/${session.id}/chat`, "POST", {
      message: "Use general assistant",
      expertId: null,
      skillIds: [],
    });
    assert.ok(next.includes("event: done"));
    const cleared = captured[1].messages[0].content;
    assert.equal(cleared.includes("EXPERT_CONTEXT_MARKER"), false);
    assert.equal(cleared.includes("SELECTED_SKILL_MARKER"), false);
    assert.ok(cleared.includes("PERSISTENT_MEMORY_MARKER"));
    assert.ok(cleared.includes("SESSION_PROMPT_MARKER"));
    assert.ok(captured[1].messages.some((message) => message.content === "Fixture response"));
    await request(`/api/skills/${unused.id}`, "DELETE");
    assert.equal((await request("/api/skills")).length, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});
