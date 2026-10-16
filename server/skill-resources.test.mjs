import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + s.address().port)));
test("selected skill reference tool denies other skills traversal links and oversized files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-skill-boundary-")),
    dataDir = path.join(dir, "data"),
    root = path.join(dataDir, "skills", "proof");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "proof.txt"), "ALLOWED_PROOF");
  await fs.writeFile(path.join(root, "SKILL.md"), "Read selected references.");
  await fs.writeFile(path.join(dir, "outside.txt"), "PRIVATE_OUTSIDE");
  await fs.symlink(path.join(dir, "outside.txt"), path.join(root, "link.txt"));
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(100001));
  let round = 0;
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (round++ === 0)
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { skillId: "selected", path: "proof.txt" },
                  { skillId: "other", path: "proof.txt" },
                  { skillId: "selected", path: "../../../../outside.txt" },
                  { skillId: "selected", path: "link.txt" },
                  { skillId: "selected", path: "large.txt" },
                  { skillId: "selected", path: path.join(dir, "outside.txt") },
                ].map((args, i) => ({
                  id: "call" + i,
                  type: "function",
                  function: { name: "skill_resource_read", arguments: JSON.stringify(args) },
                })),
              },
            },
          ],
        }),
      );
    else {
      const results = body.messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content));
      assert.equal(results[0], "ALLOWED_PROOF");
      assert.equal(results.length, 6);
      assert(results.slice(1).every((x) => x.error));
      assert(!JSON.stringify(results).includes("PRIVATE_OUTSIDE"));
      res.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "checked" } }] }),
      );
    }
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir }),
    url = await listen(app);
  const api = async (route, method = "GET", body) =>
    fetch(url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "test" });
    await api("/skills/selected", "PUT", {
      name: "selected",
      content: "Read proof",
      localRootDir: root,
    });
    const session = await (await api("/sessions", "POST", { title: "boundaries" })).json();
    const stream = await (
      await api("/sessions/" + session.id + "/chat", "POST", {
        message: "read",
        mode: "ask",
        skillIds: ["selected"],
      })
    ).text();
    assert(!stream.includes("event: error"));
    assert(stream.includes("checked"));
    const events = await (await api("/sessions/" + session.id + "/events")).json();
    assert.equal(events.filter((e) => e.event === "tool_result").length, 6);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("selected local skill instructions reload every request and reject escaping links before model access", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-skill-edit-")),
    dataDir = path.join(dir, "data"),
    root = path.join(dataDir, "skills", "proof");
  await fs.mkdir(root, { recursive: true });
  const filename = path.join(root, "SKILL.md");
  await fs.writeFile(filename, "FIRST_INSTRUCTION");
  const systems = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    systems.push(JSON.parse(raw).messages[0].content);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir }),
    url = await listen(app);
  const api = async (route, method = "GET", body) =>
    fetch(url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "test" });
    await api("/skills/proof", "PUT", {
      name: "proof",
      content: "STALE_DATABASE",
      localRootDir: root,
    });
    const session = await (await api("/sessions", "POST", { title: "edit" })).json();
    const chat = () =>
      api("/sessions/" + session.id + "/chat", "POST", {
        message: "test",
        mode: "ask",
        skillIds: ["proof"],
      });
    await (await chat()).text();
    await fs.writeFile(filename, "SECOND_INSTRUCTION");
    await (await chat()).text();
    assert(systems[0].includes("FIRST_INSTRUCTION"));
    assert(systems[1].includes("SECOND_INSTRUCTION"));
    assert(!systems[1].includes("STALE_DATABASE"));
    await fs.rename(filename, path.join(root, "previous.md"));
    await fs.writeFile(path.join(dir, "outside.md"), "PRIVATE");
    await fs.symlink(path.join(dir, "outside.md"), filename);
    const failure = await (await chat()).text();
    assert(failure.includes("Skill instructions escape package"));
    assert.equal(systems.length, 2);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("deleted or unknown selected skills fail before contacting the model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-missing-skill-"));
  let calls = 0;
  const model = http.createServer((req, res) => {
    calls++;
    res.end("{}");
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
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "test" });
    const session = await (
      await api("/sessions", "POST", { title: "missing", skillIds: ["deleted-skill"] })
    ).json();
    const stream = await (
      await api("/sessions/" + session.id + "/chat", "POST", { message: "test", mode: "ask" })
    ).text();
    assert(stream.includes("Selected skill unavailable"));
    assert.equal(calls, 0);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("automatic skill catalog loads enabled instructions on demand and rejects disabled skills", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-auto-skill-"));
  let round = 0;
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (round++ === 0) {
      assert(body.messages[0].content.includes("enabled-proof"));
      assert(!body.messages[0].content.includes("disabled-proof"));
      assert(!body.messages[0].content.includes("FULL_INSTRUCTION_PROOF"));
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: ["enabled-proof", "disabled-proof"].map((skillId, i) => ({
                  id: "invoke" + i,
                  type: "function",
                  function: { name: "skill_invoke", arguments: JSON.stringify({ skillId }) },
                })),
              },
            },
          ],
        }),
      );
    } else {
      const results = body.messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content));
      assert.equal(results[0].instructions, "FULL_INSTRUCTION_PROOF");
      assert(results[1].error);
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "loaded" } }] }));
    }
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
    await api("/config", "PUT", { baseURL: modelURL + "/v1", model: "test" });
    await api("/skills/enabled-proof", "PUT", {
      name: "enabled-proof",
      content: "FULL_INSTRUCTION_PROOF",
      enabled: true,
    });
    await api("/skills/disabled-proof", "PUT", {
      name: "disabled-proof",
      content: "DO_NOT_LOAD",
      enabled: false,
    });
    const s = await (await api("/sessions", "POST", { title: "auto" })).json();
    const stream = await (
      await api("/sessions/" + s.id + "/chat", "POST", { message: "use a skill", mode: "ask" })
    ).text();
    assert(stream.includes("loaded"));
    assert(!stream.includes("event: error"));
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
