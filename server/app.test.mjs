import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "./app.mjs";
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
test("streamed tool approval, secret redaction, symlink containment and persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-test-")),
    workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(dir, "outside"), "private");
  await fs.symlink(dir, path.join(workspace, "escape"));
  let round = 0;
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const calls =
      round++ === 0
        ? [
            {
              index: 0,
              id: "call1",
              function: {
                name: "workspace_write",
                arguments: JSON.stringify({ path: "hello.txt", content: "approved" }),
              },
            },
            {
              index: 1,
              id: "call2",
              function: {
                name: "workspace_read",
                arguments: JSON.stringify({ path: "escape/outside" }),
              },
            },
          ]
        : null;
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ delta: calls ? { tool_calls: calls } : { content: "Finished" } }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) => {
    const r = await fetch(url + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  try {
    const config = await request("/api/config", "PUT", {
      baseURL: modelURL + "/v1",
      model: "stub",
      apiKey: "secret",
      workspace,
    });
    assert.equal(config.apiKey, undefined);
    assert.equal(config.apiKeySet, true);
    const session = await request("/api/sessions", "POST", { title: "Test" });
    const response = await fetch(url + `/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Write hello", mode: "craft" }),
    });
    const reader = response.body.getReader();
    let all = "",
      approved = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      all += new TextDecoder().decode(value);
      if (!approved && all.includes("event: approval")) {
        await assert.rejects(fs.readFile(path.join(workspace, "hello.txt")));
        const pending = await request("/api/approvals");
        assert.equal(pending[0].name, "workspace_write");
        await request("/api/approvals/" + pending[0].id, "POST", { decision: "approve" });
        approved = true;
      }
    }
    assert.equal(await fs.readFile(path.join(workspace, "hello.txt"), "utf8"), "approved");
    assert.match(all, /Symlink escapes workspace/);
    assert.match(all, /event: done/);
    assert.equal((await request(`/api/sessions/${session.id}/messages`)).length, 2);
    const followup = await fetch(url + `/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Remember the tool result" }),
    });
    await followup.text();
    assert.ok(requests[2].messages.some((m) => m.role === "tool" && m.content.includes("Written")));
    assert.ok(requests[2].messages.some((m) => m.role === "assistant" && m.tool_calls));
    const denied = await fetch(url + "/api/config", {
      headers: { Origin: "https://evil.invalid" },
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
  const reopened = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url2 = await listen(reopened);
  assert.equal((await (await fetch(url2 + "/api/sessions")).json()).length, 1);
  await new Promise((r) => reopened.close(r));
});
test("ask mode blocks writes and cross-port origins are rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-ask-"));
  let round = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: round++
                ? { content: "Denied" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c",
                        function: {
                          name: "workspace_write",
                          arguments: JSON.stringify({ path: "forbidden.txt", content: "bad" }),
                        },
                      },
                    ],
                  },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const post = async (route, body) =>
    fetch(url + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await fetch(url + "/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseURL: modelURL, model: "stub", workspace: dir }),
    });
    const s = await (await post("/api/sessions", {})).json();
    const stream = await (
      await post(`/api/sessions/${s.id}/chat`, { message: "write", mode: "ask" })
    ).text();
    assert.match(stream, /Ask mode forbids/);
    assert.doesNotMatch(stream, /event: approval/);
    await assert.rejects(fs.readFile(path.join(dir, "forbidden.txt")));
    assert.equal(
      (await fetch(url + "/api/config", { headers: { Origin: "http://127.0.0.1:1" } })).status,
      403,
    );
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Expected state did not arrive");
}
test("automation approval persisted, cancellation clears permission and restart interrupts stale runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-auto-"));
  let round = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: round++
                ? { content: "Complete" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c",
                        function: {
                          name: "workspace_write",
                          arguments: JSON.stringify({ path: "auto.txt", content: "approved" }),
                        },
                      },
                    ],
                  },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) => {
    const response = await fetch(url + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
  try {
    await request("/api/config", "PUT", { baseURL: modelURL, model: "stub", workspace: dir });
    const automation = await request("/api/automations", "POST", {
      name: "Test",
      prompt: "write file",
      mode: "craft",
    });
    const run = await request(`/api/automations/${automation.id}/run`, "POST", {});
    let state;
    await eventually(async () => {
      state = (await request("/api/runs")).find((r) => r.id === run.id);
      return state.status === "awaiting_approval";
    });
    assert.equal(state.approval.name, "workspace_write");
    assert.equal((await request(`/api/sessions/${run.sessionId}`)).status, "pending");
    assert.equal((await request(`/api/sessions/${run.sessionId}`)).pendingInputKind, "permission");
    await assert.rejects(fs.readFile(path.join(dir, "auto.txt")));
    await request(`/api/sessions/${run.sessionId}/cancel`, "POST", {});
    await eventually(async () => !(await request("/api/approvals")).length);
    await eventually(
      async () => (await request("/api/runs")).find((r) => r.id === run.id).status === "cancelled",
    );
    assert.equal((await request(`/api/sessions/${run.sessionId}`)).status, "cancelled");
    assert.equal((await request(`/api/sessions/${run.sessionId}`)).pendingInputKind, null);
    await assert.rejects(fs.readFile(path.join(dir, "auto.txt")));
    const stale = await request("/api/sessions", "POST", {
      status: "pending",
      pendingInputKind: "permission",
    });
    await request("/api/runs", "POST", {
      status: "running",
      automationId: "stale",
      sessionId: stale.id,
    });
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
  const restarted = createAppServer({ dataDir: path.join(dir, "appdata") }),
    restartURL = await listen(restarted);
  try {
    const runs = await (await fetch(restartURL + "/api/runs")).json();
    assert.equal(runs.find((r) => r.automationId === "stale").status, "interrupted");
    const session = await (
      await fetch(
        restartURL + "/api/sessions/" + runs.find((r) => r.automationId === "stale").sessionId,
      )
    ).json();
    assert.equal(session.status, "interrupted");
    assert.equal(session.pendingInputKind, null);
  } finally {
    await new Promise((r) => restarted.close(r));
  }
});
test("scheduled automation executes and advances persisted nextRunAt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-schedule-"));
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "Scheduled completion" } }] }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) => {
    const response = await fetch(url + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
  try {
    await request("/api/config", "PUT", { baseURL: modelURL, model: "stub", workspace: dir });
    const automation = await request("/api/automations", "POST", {
      name: "Schedule",
      prompt: "respond",
      enabled: true,
      intervalMinutes: 1,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    await eventually(async () =>
      (await request("/api/runs")).some(
        (r) => r.automationId === automation.id && r.status === "completed",
      ),
    );
    const stored = await request("/api/automations/" + automation.id);
    assert.ok(Date.parse(stored.nextRunAt) > Date.now());
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
test("JSON response compatibility, supportsTools false, model errors and workspace binding", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-json-")),
    other = await fs.mkdtemp(path.join(os.tmpdir(), "wb-other-"));
  let requests = [],
    fail = false;
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": fail ? "text/event-stream" : "application/json" });
    res.end(
      fail
        ? 'data: {"error":{"message":"model failure"}}\n\n'
        : JSON.stringify({
            choices: [{ message: { role: "assistant", content: "JSON supported" } }],
          }),
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) => {
    const r = await fetch(url + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  const chat = async (id, body) =>
    (
      await fetch(url + `/api/sessions/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).text();
  try {
    await request("/api/config", "PUT", {
      baseURL: modelURL,
      model: "stub",
      workspace: dir,
      supportsTools: false,
    });
    const session = await request("/api/sessions", "POST", {});
    const expert = await request("/api/experts/custom-expert%3Aencoded", "PUT", {
      systemPrompt: "ENCODED_EXPERT_INSTRUCTIONS",
    });
    assert.equal(expert.id, "custom-expert:encoded");
    assert.equal((await fetch(url + "/api/experts/%ZZ")).status, 400);
    assert.match(
      await chat(session.id, { message: "first", mode: "craft", expertId: expert.id }),
      /JSON supported/,
    );
    assert(requests[0].messages[0].content.includes("ENCODED_EXPERT_INSTRUCTIONS"));
    assert.equal(requests[0].tools, undefined);
    await request("/api/config", "PUT", { workspace: other });
    assert.match(await chat(session.id, { message: "second" }), /event: done/);
    const saved = await request("/api/sessions/" + session.id);
    assert.equal(saved.workspace, await fs.realpath(dir));
    assert.equal(saved.mode, "craft");
    assert.equal(requests[1].messages.filter((m) => m.role === "assistant").length, 1);
    fail = true;
    const result = await chat(session.id, { message: "fail" });
    assert.match(result, /model failure/);
    assert.doesNotMatch(result, /event: done/);
    assert.equal(
      (await request(`/api/sessions/${session.id}/messages`)).filter((m) => m.role === "assistant")
        .length,
      2,
    );
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
test("completed tool evidence survives a subsequent model HTTP failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-failure-"));
  let round = 0;
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    const current = round++;
    if (current === 1) {
      res.writeHead(500);
      res.end("provider unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta:
                current === 0
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "written",
                          function: {
                            name: "workspace_write",
                            arguments: JSON.stringify({ path: "sideeffect.txt", content: "done" }),
                          },
                        },
                      ],
                    }
                  : { content: "Previous tool fact retained" },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "appdata") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) =>
    (
      await fetch(url + route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
    ).json();
  try {
    await request("/api/config", "PUT", { baseURL: modelURL, model: "stub", workspace: dir });
    const session = await request("/api/sessions", "POST", {});
    const response = await fetch(url + `/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "write", mode: "craft" }),
    });
    const reader = response.body.getReader();
    let stream = "",
      approved = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream += new TextDecoder().decode(value);
      if (!approved && stream.includes("event: approval")) {
        const p = (await request("/api/approvals"))[0];
        await request("/api/approvals/" + p.id, "POST", { decision: "approve" });
        approved = true;
      }
    }
    assert.match(stream, /HTTP 500/);
    assert.equal(await fs.readFile(path.join(dir, "sideeffect.txt"), "utf8"), "done");
    const followup = await fetch(url + `/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What happened?" }),
    });
    await followup.text();
    const history = requests[2].messages;
    assert.ok(history.some((m) => m.role === "tool" && m.content.includes("Written")));
    assert.equal(history.find((m) => m.tool_calls).tool_calls.length, 1);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
test("workspace tools cannot read or search application private data", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-private-")),
    dataDir = path.join(dir, "appdata");
  let round = 0;
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: round++
                ? { content: "Protected" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "read",
                        function: {
                          name: "workspace_read",
                          arguments: JSON.stringify({ path: "appdata/workbuddy.sqlite" }),
                        },
                      },
                      {
                        index: 1,
                        id: "search",
                        function: {
                          name: "workspace_search",
                          arguments: JSON.stringify({ query: "SECRET_MARKER" }),
                        },
                      },
                    ],
                  },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir }),
    url = await listen(app);
  const request = async (route, method = "GET", body) =>
    (
      await fetch(url + route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
    ).json();
  try {
    await fs.writeFile(path.join(dataDir, "private.txt"), "SECRET_MARKER_private");
    await fs.writeFile(path.join(dir, "normal.txt"), "SECRET_MARKER_public");
    await request("/api/config", "PUT", {
      baseURL: modelURL,
      model: "stub",
      workspace: dir,
      apiKey: "SECRET_MARKER_key",
    });
    const session = await request("/api/sessions", "POST", {});
    const response = await fetch(url + `/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "search" }),
    });
    const stream = await response.text();
    assert.match(stream, /private data directory/);
    assert.doesNotMatch(stream, /SECRET_MARKER_private|SECRET_MARKER_key/);
    assert.match(stream, /SECRET_MARKER_public/);
    const outputs = requests[1].messages
      .filter((m) => m.role === "tool")
      .map((m) => m.content)
      .join(" ");
    assert.doesNotMatch(outputs, /SECRET_MARKER_private|SECRET_MARKER_key/);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});

test("approved expert skill commands receive an independent config root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-env-"));
  const dataDir = path.join(dir, "data");
  let calls = 0,
    commandOutput;
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    if (calls === 2) commandOutput = body.messages.find((m) => m.role === "tool")?.content;
    const message =
      calls === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "expert-env",
                type: "function",
                function: {
                  name: "shell_execute",
                  arguments: JSON.stringify({ command: "printf '%s' \"$WORKBUDDY_CONFIG_DIR\"" }),
                },
              },
            ],
          }
        : { role: "assistant", content: "verified" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir }),
    url = await listen(app);
  const api = async (route, method = "GET", body) =>
    (
      await fetch(url + "/api" + route, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json();
  try {
    await api("/config", "PUT", { baseURL: modelURL, model: "fixture", workspace: dir });
    const session = await api("/sessions", "POST", {});
    const response = await fetch(url + "/api/sessions/" + session.id + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "inspect config", mode: "craft" }),
    });
    let stream = "",
      approved = false;
    for await (const bytes of response.body) {
      stream += new TextDecoder().decode(bytes);
      if (!approved && stream.includes("event: approval")) {
        const permission = (await api("/approvals"))[0];
        await api("/approvals/" + permission.id, "POST", { decision: "approve" });
        approved = true;
      }
    }
    assert.equal(approved, true);
    assert(commandOutput.includes(path.join(dir, "expert-config")));
    assert(!commandOutput.includes(path.join(os.homedir(), ".workbuddy")));
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

test("custom expert avatar URL serves package pixels and denies text and outside symlinks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-avatar-")),
    dataDir = path.join(dir, "data");
  const root = path.join(dir, "expert-config/plugins/marketplaces/my-experts/plugins/avatar-proof");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.mkdir(path.join(root, "avatars"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({
      name: "avatar-proof",
      agentName: "avatar-proof",
      expertType: "agent",
      avatar: "avatars/proof.png",
    }),
  );
  await fs.writeFile(path.join(root, "agents/avatar-proof.md"), "Private instructions");
  const pixels = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(path.join(root, "avatars/proof.png"), pixels);
  const outside = path.join(dir, "outside.png");
  await fs.writeFile(outside, pixels);
  await fs.symlink(outside, path.join(root, "avatars/outside.png"));
  const app = createAppServer({ dataDir }),
    origin = await listen(app);
  const { createRequire } = await import("node:module");
  const { createDispatcher } = createRequire(import.meta.url)("../desktop/dispatcher.cjs");
  try {
    const d = createDispatcher({ origin, dataDir });
    const scanned = await d("expert:scanCustomExperts");
    const avatar = scanned.experts[0].avatar;
    const response = await fetch(avatar);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixels);
    const base =
      origin + "/api/expert-resources/" + encodeURIComponent(scanned.experts[0].id) + "/";
    assert.equal((await fetch(base + "agents/avatar-proof.md")).status, 403);
    assert.equal((await fetch(base + "avatars/outside.png")).status, 403);
    assert.equal((await fetch(avatar, { headers: { Origin: "http://outside.test" } })).status, 403);
  } finally {
    await new Promise((r) => app.close(r));
  }
});

test("malformed model tool arguments persist a paired failed card without execution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-invalid-args-"));
  let round = 0;
  const model = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              round++ === 0
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: ["null", "[]", "{broken"].map((argumentsText, i) => ({
                      id: "bad-" + i,
                      type: "function",
                      function: { name: "workspace_write", arguments: argumentsText },
                    })),
                  }
                : { role: "assistant", content: "参数错误，未执行。" },
          },
        ],
      }),
    );
  });
  const modelURL = await listen(model),
    app = createAppServer({ dataDir: path.join(dir, "data") }),
    url = await listen(app);
  const request = async (route, method = "GET", body) =>
    fetch(url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await request("/config", "PUT", { baseURL: modelURL + "/v1", model: "test", workspace: dir });
    const session = await (
      await request("/sessions", "POST", { title: "Invalid arguments" })
    ).json();
    const stream = await (
      await request("/sessions/" + session.id + "/chat", "POST", { message: "test", mode: "craft" })
    ).text();
    assert(!stream.includes("event: approval"));
    const events = await (await request("/sessions/" + session.id + "/events")).json();
    const starts = events.filter((e) => e.event === "tool"),
      results = events.filter((e) => e.event === "tool_result");
    assert.equal(starts.length, 3);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert(result.data.result.error);
      assert(starts.some((start) => start.data.toolCallId === result.data.toolCallId));
    }
    assert.equal((await (await request("/approvals")).json()).length, 0);
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => model.close(r));
  }
});
