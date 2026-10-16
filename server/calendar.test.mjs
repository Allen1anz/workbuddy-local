import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
const wait = async (fn) => {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Calendar execution timed out");
};
test("calendar once fires once with selected model, instructions and real write approval; recurring advances", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-calendar-")),
    workspace = path.join(dir, "workspace"),
    dataDir = path.join(dir, "private");
  await fs.mkdir(workspace);
  const calls = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const done = body.messages.some((m) => m.role === "tool");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: done
              ? { content: "Calendar task done" }
              : {
                  content: null,
                  tool_calls: [
                    {
                      id: "calendar-write",
                      type: "function",
                      function: {
                        name: "workspace_write",
                        arguments: JSON.stringify({
                          path: "calendar-proof.txt",
                          content: "approved calendar output",
                        }),
                      },
                    },
                  ],
                },
          },
        ],
      }),
    );
  });
  let app = createAppServer({ dataDir }),
    base = await listen(app);
  const modelBase = await listen(model);
  const request = async (route, method = "GET", body) => {
    const r = await fetch(base + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await r.json();
    assert(r.ok, JSON.stringify(value));
    return value;
  };
  try {
    await request("/config", "PUT", {
      baseURL: modelBase + "/v1",
      model: "wrong-default-model",
      workspace,
      supportsTools: true,
    });
    await request("/experts/expert", "PUT", {
      name: "Calendar expert",
      systemPrompt: "CALENDAR_EXPERT_MARKER",
    });
    await request("/skills/skill", "PUT", {
      name: "Calendar skill",
      content: "CALENDAR_SKILL_MARKER",
      enabled: true,
    });
    const once = await request("/automations", "POST", {
      name: "Once",
      prompt: "Write the proof file",
      scheduleType: "once",
      scheduledAt: new Date(Date.now() + 1200).toISOString(),
      status: "ACTIVE",
      mode: "craft",
      model: "selected-calendar-model",
      expertId: "expert",
      skillIds: ["skill"],
      workspace,
    });
    assert(once.nextRunAt);
    const approval = await wait(async () => {
      const a = await request("/approvals");
      return a[0];
    });
    await assert.rejects(fs.stat(path.join(workspace, "calendar-proof.txt")), { code: "ENOENT" });
    assert.equal(calls[0].model, "selected-calendar-model");
    assert(calls[0].messages[0].content.includes("CALENDAR_EXPERT_MARKER"));
    assert(calls[0].messages[0].content.includes("CALENDAR_SKILL_MARKER"));
    await request("/approvals/" + approval.id, "POST", { decision: "approve" });
    await wait(async () => {
      const r = await request("/runs");
      return r.find((x) => x.status === "completed");
    });
    assert.equal(
      await fs.readFile(path.join(workspace, "calendar-proof.txt"), "utf8"),
      "approved calendar output",
    );
    const saved = await request("/automations/" + once.id);
    assert.equal(saved.status, "PAUSED");
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextRunAt, null);
    const completedSession = await request("/sessions/" + (await request("/runs"))[0].sessionId);
    assert.equal(completedSession.status, "completed");
    assert.equal(completedSession.pendingInputKind, null);
    await new Promise((r) => app.close(r));
    app = createAppServer({ dataDir });
    base = await listen(app);
    assert.equal((await request("/runs")).length, 1);
    const recurring = await request("/automations", "POST", {
      name: "Hourly",
      prompt: "Write proof",
      scheduleType: "recurring",
      rrule: "FREQ=HOURLY;INTERVAL=1",
      scheduleAnchor: new Date(Date.now() + 1200 - 3600000).toISOString(),
      status: "ACTIVE",
      workspace,
      mode: "craft",
      model: "selected-calendar-model",
    });
    const next = await wait(async () => {
      const r = await request("/automations/" + recurring.id);
      return Date.parse(r.nextRunAt) > Date.now() + 3000000 ? r : null;
    });
    assert.equal(next.status, "ACTIVE");
    assert.equal((await request("/runs")).length, 2);
    const paused = await request("/automations/" + recurring.id, "PUT", { status: "PAUSED" });
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("automation without a selected workspace gets a unique usable directory outside private data", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-calendar-default-cwd-"));
  const dataDir = path.join(dir, "data");
  const model = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
  });
  const modelBase = await listen(model);
  const app = createAppServer({ dataDir });
  const base = await listen(app);
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.ok, true);
    return response.json();
  };
  try {
    await request("/config", "PUT", {
      baseURL: modelBase + "/v1",
      model: "fixture",
      workspace: "",
    });
    const automation = await request("/automations", "POST", {
      name: "No folder",
      prompt: "test",
      enabled: false,
    });
    const first = await request("/automations/" + automation.id + "/run", "POST", {});
    await wait(async () => (await request("/runs/" + first.id)).status === "completed");
    const second = await request("/automations/" + automation.id + "/run", "POST", {});
    const session = await request("/sessions/" + first.sessionId);
    assert.equal(first.workspace, session.workspace);
    assert.equal(first.workspace.startsWith(dataDir + path.sep), false);
    assert.equal((await fs.stat(first.workspace)).isDirectory(), true);
    assert.notEqual(first.workspace, second.workspace);
    await fs.writeFile(path.join(first.workspace, "proof.txt"), "usable");
    assert.equal(await fs.readFile(path.join(first.workspace, "proof.txt"), "utf8"), "usable");
    await wait(async () => (await request("/runs/" + second.id)).status === "completed");
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

test("multi-workspace automation creates separate approvals and writes in each selected directory", async () => {
  const { createRequire } = await import("node:module");
  const { createDispatcher } = createRequire(import.meta.url)("../desktop/dispatcher.cjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-auto-multi-")),
    cwds = [path.join(dir, "one"), path.join(dir, "two")];
  for (const cwd of cwds) await fs.mkdir(cwd);
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const complete = body.messages.some((m) => m.role === "tool");
    const message = complete
      ? { role: "assistant", content: "done" }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write",
              type: "function",
              function: {
                name: "workspace_write",
                arguments: JSON.stringify({ path: "proof.txt", content: "multi workspace output" }),
              },
            },
          ],
        };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const modelBase = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "data") }),
    base = await listen(app);
  const request = async (route, method = "GET", body) => {
    const r = await fetch(base + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, value: await r.json() };
  };
  try {
    await request("/config", "PUT", { baseURL: modelBase + "/v1", model: "fixture" });
    const automation = (
      await request("/automations", "POST", {
        name: "Multi",
        prompt: "Write proof",
        cwds,
        mode: "craft",
        enabled: false,
      })
    ).value;
    const started = await request("/automations/" + automation.id + "/run", "POST", {});
    const d = createDispatcher({ origin: base, dataDir: path.join(dir, "data") });
    assert.equal(started.status, 202);
    assert.equal(started.value.runs.length, 2);
    assert.equal((await request("/automations/" + automation.id + "/run", "POST", {})).status, 400);
    const approvals = await wait(async () => {
      const list = (await request("/approvals")).value;
      return list.length === 2 ? list : null;
    });
    const pendingSnapshot = await d("automation:getSnapshot");
    assert.equal(pendingSnapshot.inbox.length, 1);
    assert.equal(pendingSnapshot.inbox[0].runs.length, 2);
    assert.equal(pendingSnapshot.inbox[0].status, "IN_PROGRESS");
    await assert.rejects(d("automation:archiveInboxItem", [started.value.id]));
    for (const cwd of cwds)
      await assert.rejects(fs.stat(path.join(cwd, "proof.txt")), { code: "ENOENT" });
    for (const approval of approvals)
      await request("/approvals/" + approval.id, "POST", { decision: "approve" });
    const runs = await wait(async () => {
      const rows = (await request("/runs")).value;
      return rows.every((r) => r.status === "completed") ? rows : null;
    });
    assert.equal(new Set(runs.map((r) => r.sessionId)).size, 2);
    assert.equal(new Set(runs.map((r) => r.groupId)).size, 1);
    for (const cwd of cwds)
      assert.equal(
        await fs.readFile(path.join(cwd, "proof.txt"), "utf8"),
        "multi workspace output",
      );
    const complete = await d("automation:getSnapshot");
    assert.equal(complete.inbox[0].success, true);
    assert.deepEqual(
      new Set(complete.inbox[0].runs.map((run) => run.cwd)),
      new Set(await Promise.all(cwds.map((cwd) => fs.realpath(cwd)))),
    );
    await d("automation:archiveInboxItem", [started.value.id]);
    assert((await request("/runs")).value.every((run) => run.archived));
    assert.equal((await d("automation:getSnapshot")).inbox[0].archived, true);
    await d("automation:deleteInboxItem", [started.value.id]);
    assert.equal((await request("/runs")).value.length, 0);
    assert.equal((await request("/sessions")).value.length, 2);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("automation reloads edited local expert instructions before each model request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-auto-expert-refresh-")),
    dataDir = path.join(dir, "data"),
    root = path.join(dir, "expert-config/plugins/marketplaces/my-experts/plugins/author");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({ name: "author", agentName: "author", expertType: "agent" }),
  );
  const agent = path.join(root, "agents/author.md");
  await fs.writeFile(agent, "UPDATED_FILE_INSTRUCTIONS");
  const calls = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const bytes of req) raw += bytes;
    calls.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
  });
  const modelBase = await listen(model),
    app = createAppServer({ dataDir }),
    base = await listen(app);
  const request = async (route, method = "GET", body) => {
    const r = await fetch(base + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.ok, true);
    return r.json();
  };
  try {
    await request("/config", "PUT", { baseURL: modelBase + "/v1", model: "fixture" });
    await request("/experts/custom-expert%3Aauthor", "PUT", {
      source: "local-expert-package",
      systemPrompt: "STALE_DB_INSTRUCTIONS",
    });
    const automation = await request("/automations", "POST", {
      name: "Refresh",
      prompt: "test",
      expertId: "custom-expert:author",
      enabled: false,
    });
    const first = await request("/automations/" + automation.id + "/run", "POST", {});
    await wait(async () => (await request("/runs/" + first.id)).status === "completed");
    assert(calls[0].messages[0].content.includes("UPDATED_FILE_INSTRUCTIONS"));
    assert(!calls[0].messages[0].content.includes("STALE_DB_INSTRUCTIONS"));
    await fs.writeFile(agent, "SECOND_FILE_INSTRUCTIONS");
    const second = await request("/automations/" + automation.id + "/run", "POST", {});
    await wait(async () => (await request("/runs/" + second.id)).status === "completed");
    assert(calls[1].messages[0].content.includes("SECOND_FILE_INSTRUCTIONS"));
    assert(!calls[1].messages[0].content.includes("UPDATED_FILE_INSTRUCTIONS"));
    await fs.rename(agent, agent + ".saved");
    const third = await request("/automations/" + automation.id + "/run", "POST", {});
    const failed = await wait(async () => {
      const run = await request("/runs/" + third.id);
      return run.status === "failed" ? run : null;
    });
    assert.match(failed.error, /unavailable/);
    assert.equal(calls.length, 2);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
