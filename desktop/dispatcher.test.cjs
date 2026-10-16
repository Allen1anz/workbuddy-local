const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");
test("failed selected model deletion preserves saved models and emits no selector refresh", async () => {
  const f = await fixture();
  let fail = false;
  const d = createDispatcher({...f.options,fetchImpl:async(url,options)=> {
    if (fail && url.endsWith("/api/config") && options.method === "PUT")
      return {ok:false,status:503,json:async()=>({error:"provider update unavailable"})};
    return f.options.fetchImpl(url,options);
  }});
  await d("config:saveLocalCustomModel",[{model:{id:"retained",url:"http://localhost:9011/v1"}}]);
  await d("config:saveLocalCustomModel",[{model:{id:"selected",url:"http://localhost:9012/v1"}}]);
  f.events.length = 0;
  fail = true;
  await assert.rejects(d("config:deleteLocalCustomModel",[{id:"selected"}]),/provider update unavailable/);
  const reloaded = createDispatcher(f.options);
  assert.deepEqual((await reloaded("config:getLocalCustomModels")).models.map(x=>x.id),["retained","selected"]);
  assert.equal(f.events.some(x=>x.channel==="config:productConfigurationChanged"),false);
});
test("model deletion refreshes selector configuration and selects the remaining endpoint", async () => {
  const f = await fixture();
  const d = createDispatcher(f.options);
  await d("config:saveLocalCustomModel",[{model:{id:"first",url:"http://localhost:9011/v1",apiKey:"test-only"}}]);
  await d("config:saveLocalCustomModel",[{model:{id:"second",url:"http://localhost:9012/v1",apiKey:"test-only"}}]);
  f.events.length = 0;
  const result = await d("config:deleteLocalCustomModel",[{id:"second"}]);
  assert.deepEqual(result.models.map(x=>x.id),["first"]);
  const event = f.events.find(x=>x.channel==="config:productConfigurationChanged");
  assert(event);
  assert.deepEqual(event.result.productConfiguration.availableModels,["custom-local:first"]);
  assert.equal((await d("config:getProductConfiguration")).agents[0].defaultModel,"custom-local:first");
  assert(f.calls.some(x=>x.route==="/config" && x.method==="PUT" && x.body.model==="first" && x.body.baseURL==="http://localhost:9011/v1"));
});
test("personalization rolls back disk and model preference after a lost save response", async () => {
  const f = await fixture();
  let fail = false;
  const d = createDispatcher({...f.options, fetchImpl: async (url, options) => {
    const result = await f.options.fetchImpl(url,options);
    if (fail && url.endsWith("/memories/desktop-personalization") && options.method === "PUT") {
      fail = false;
      throw Error("save response lost");
    }
    return result;
  }});
  const original = {toneStyle:"efficient",customPrompt:"保持原偏好"};
  await d("config:set",["personalization",original]);
  f.events.length = 0;
  fail = true;
  await assert.rejects(d("config:set",["personalization",{toneStyle:"socratic",customPrompt:"未成功偏好"}]),/response lost/);
  assert.deepEqual((await d("config:getAll")).personalization,original);
  const saved = JSON.parse(await fs.readFile(path.join(f.dir,"desktop-settings.json"),"utf8"));
  assert.deepEqual(saved.values.personalization,original);
  assert.match(f.entities.memories.find(x=>x.id==="desktop-personalization").content,/保持原偏好/);
  assert.doesNotMatch(f.entities.memories.find(x=>x.id==="desktop-personalization").content,/未成功偏好|启发引导/);
  assert.equal(f.events.some(x=>x.channel==="config:changed"),false);
});
test("invalid personalization fails before changing saved settings or model preference", async () => {
  const f = await fixture();
  const d = createDispatcher(f.options);
  const before = await d("config:getAll");
  const snapshot = JSON.stringify(before);
  for (const value of [null, [], "invalid", {toneStyle:"unknown"}, {toneStyle:4}, {customPrompt:5}, {customPrompt:"x".repeat(1501)}]) {
    await assert.rejects(d("config:set",["personalization",value]),/Personalization|personalization/);
    assert.equal(JSON.stringify(await d("config:getAll")),snapshot);
  }
});
test("local skill entry remains available while cloud scan requests fail explicitly", async () => {
  const f = await fixture();
  const d = createDispatcher(f.options);
  const policy = await d("enterprisePolicy:refreshSkillUploadPolicy");
  assert.equal(policy.allowed,true);
  assert.equal(policy.cloudScanAvailable,false);
  await assert.rejects(d("skill:import",[{securityCheck:true,content:"---\nname: test\ndescription: test\n---\n"}]),{code:"LOCAL_SKILL_SCAN_UNAVAILABLE"});
});
test("local appearance uses renderer base resources and retains unbilled local identity", async () => {
  const f = await fixture();
  const d = createDispatcher(f.options);
  assert.equal((await d("config:getProductConfiguration")).productFeatures.EnableAppearance,true);
  const product = await d("config:getProductConfiguration");
  assert.equal(product.productFeatures.ShowAboutQRCodes,true);
  assert.equal(product.productFeatures.ChannelWechatKf,true);
  assert.equal(product.productFeatures.DisableYuanbaoChannel,true);
  assert.deepEqual(product.links,{officialWebsite:"https://www.workbuddy.cn/",helpDocument:"https://www.workbuddy.cn/docs/workbuddy/Overview"});
  assert.deepEqual(await d("appearance:listResources",[{lang:"zh"}]),[]);
  assert.equal((await d("auth:getAccount")).editionType,undefined);
});

test("automation archive persists in SQLite and record deletion preserves its conversation", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-inbox-lifecycle-"));
  const server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const api = async (route, method = "GET", body) => {
    const response = await fetch(origin + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.ok, true);
    return response.json();
  };
  try {
    const session = await api("/sessions", "POST", { title: "保留对话" });
    const run = await api("/runs", "POST", {
      sessionId: session.id,
      status: "completed",
      output: "模型输出保留",
    });
    const d = createDispatcher({ origin, dataDir });
    await assert.rejects(d("automation:deleteInboxItem", [run.id]), /先归档/);
    assert.deepEqual(await d("automation:archiveInboxItem", [run.id]), { success: true });
    const reopened = createDispatcher({ origin, dataDir });
    const snapshot = await reopened("automation:getSnapshot");
    assert.equal(snapshot.inbox[0].archived, true);
    assert.equal(snapshot.inbox[0].summary, "模型输出保留");
    assert.deepEqual(await reopened("automation:deleteInboxItem", [run.id]), { success: true });
    assert.equal((await api("/runs")).length, 0);
    assert.equal((await api("/sessions/" + session.id)).title, "保留对话");
    await assert.rejects(reopened("automation:archiveInboxItem", [run.id]), /找不到/);
    await reopened("session:rename", [session.id, "人工命名"]);
    assert.equal((await api("/sessions/" + session.id)).isUserDefinedTitle, 1);
    await assert.rejects(reopened("session:rename", ["missing", "幽灵任务"]), /找不到/);
    await assert.rejects(reopened("session:rename", [session.id, "   "]), /名称/);
    await reopened("session:archive", [session.id]);
    assert.equal((await reopened("session:list")).agents[0].status, "archived");
    const restored = createDispatcher({ origin, dataDir });
    await restored("session:updateStatus", [session.id, "completed"]);
    const savedSession = await api("/sessions/" + session.id);
    assert.equal(savedSession.archived, false);
    assert.equal(savedSession.status, "completed");
    assert.equal(savedSession.title, "人工命名");
    await restored("session:pin", [session.id]);
    const pinned = createDispatcher({ origin, dataDir });
    assert.equal((await pinned("session:list")).agents[0].pinned, true);
    await pinned("session:pin", [session.id]);
    const settings = JSON.parse(
      await fs.readFile(path.join(dataDir, "desktop-settings.json"), "utf8"),
    );
    assert.deepEqual(settings.pinnedSessionIds, [session.id]);
    await pinned("session:unpin", [session.id]);
    assert.equal(
      (await createDispatcher({ origin, dataDir })("session:list")).agents[0].pinned,
      false,
    );
    await assert.rejects(pinned("session:pin", ["missing"]), /找不到/);
    await assert.rejects(restored("session:updateStatus", [session.id, "running"]), /执行器/);
    await api("/sessions/" + session.id, "PUT", { status: "pending" });
    await assert.rejects(restored("session:archive", [session.id]), /停止/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("generated workspace supports real backend tools while private app data stays protected", async () => {
  const http = require("node:http");
  const { createAppServer } = await import("../server/app.mjs");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-workspace-safety-"));
  const dataDir = path.join(profile, "data");
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const message =
      requests.length === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write",
                type: "function",
                function: {
                  name: "workspace_write",
                  arguments: JSON.stringify({ path: "test.txt", content: "workspace works" }),
                },
              },
              {
                id: "read",
                type: "function",
                function: {
                  name: "workspace_read",
                  arguments: JSON.stringify({ path: "test.txt" }),
                },
              },
              {
                id: "list",
                type: "function",
                function: { name: "workspace_list", arguments: "{}" },
              },
              {
                id: "private",
                type: "function",
                function: {
                  name: "workspace_read",
                  arguments: JSON.stringify({ path: path.join(dataDir, "workbuddy.sqlite") }),
                },
              },
            ],
          }
        : { role: "assistant", content: "done" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const backend = createAppServer({ dataDir });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen(model);
  await listen(backend);
  const origin = "http://127.0.0.1:" + backend.address().port;
  try {
    const d = createDispatcher({
      origin,
      dataDir,
      emit: (channel, result) => {
        if (result.type === "permissionRequest")
          fetch(origin + "/api/approvals/" + result.requestId, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          });
      },
    });
    const cwd = await d("workspace:generateDefaultCwd");
    assert.equal(cwd.startsWith(dataDir + path.sep), false);
    await fetch(origin + "/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:" + model.address().port + "/v1",
        model: "tool-fixture",
        workspace: cwd,
      }),
    });
    const session = await d("session:create", [{ cwd, config: { mode: "craft" } }]);
    await d("session:sendMessage", [
      session.sessionId,
      [{ type: "text", text: "workspace tool acceptance" }],
    ]);
    assert.equal(await fs.readFile(path.join(cwd, "test.txt"), "utf8"), "workspace works");
    const toolResults = requests[1].messages
      .filter((item) => item.role === "tool")
      .map((item) => JSON.parse(item.content));
    assert.equal(toolResults[0], "Written");
    assert.equal(toolResults[1], "workspace works");
    assert(toolResults[2].some((item) => item.name === "test.txt"));
    assert(toolResults[3].error);
  } finally {
    await new Promise((resolve) => backend.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

test("original MCP JSON editor persists local full configuration without launching servers", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await d("mcp:saveConfigContent", [
    {
      content: JSON.stringify({
        mcpServers: { local: { command: "node", args: ["server.mjs"], env: { TOKEN: "secret" } } },
      }),
    },
  ]);
  assert.equal(f.entities.connectors[0].transport, "stdio");
  assert.equal(f.entities.connectors[0].env.TOKEN, "secret");
  assert(!f.calls.some((call) => call.route.endsWith("/connect")));
  const config = await d("mcp:getConfigContent");
  assert.equal(JSON.parse(config.content).mcpServers.local.command, "node");
  assert.equal(JSON.parse(config.content).mcpServers.local.env.TOKEN, "secret");
  await d("mcp:saveConfigContent", [{ content: config.content }]);
  assert.equal(f.entities.connectors[0].env.TOKEN, "secret");
  await assert.rejects(
    d("mcp:saveConfigContent", [
      {
        content: JSON.stringify({
          mcpServers: {
            local: { url: "https://example.test", headers: { Authorization: 123 } },
          },
        }),
      },
    ]),
  );
  assert.equal(f.entities.connectors[0].command, "node");
});

test("calendar automation never claims unsupported RRULE schedule was saved", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await assert.rejects(
    d("automation:update", [
      {
        name: "Calendar",
        prompt: "test",
        scheduleType: "recurring",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3",
      },
    ]),
    /不支持/,
  );
  assert.equal(f.entities.automations.length, 0);
  const result = await d("automation:update", [
    { name: "Interval", prompt: "test", intervalMinutes: 5, enabled: true },
  ]);
  assert.equal(result.success, true);
  assert.equal(f.entities.automations[0].intervalMinutes, 5);
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-dispatch-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-dispatch-home-"));
  const entities = {
    skills: [{ id: "s1", name: "分析", content: "按证据分析" }],
    experts: [{ id: "e1", name: "开发", systemPrompt: "正确开发" }],
    sessions: [],
    connectors: [],
    automations: [],
    runs: [],
    memories: [],
  };
  let config = {
    model: "local-model",
    baseURL: "http://127.0.0.1:11434/v1",
    workspace: dir,
    supportsTools: true,
  };
  const calls = [],
    events = [];
  const fetchImpl = async (url, opts) => {
    const route = new URL(url).pathname.replace("/api", ""),
      parts = route.split("/").filter(Boolean).map(decodeURIComponent),
      body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ route, method: opts.method, body });
    let result,
      status = 200;
    if (parts[0] === "config") {
      if (opts.method === "PUT") config = { ...config, ...body };
      result = { ...config, apiKeySet: !!config.apiKey };
      delete result.apiKey;
    } else if (parts[0] === "connectors" && parts[1] === "config" && opts.method === "PUT") {
      const previous = entities.connectors;
      entities.connectors = body.entries.map((entry, index) => ({
        ...previous.find((old) => old.name === entry.name),
        ...entry,
        id: previous.find((old) => old.name === entry.name)?.id || "new" + index,
      }));
      await fs.writeFile(path.join(dir, "connectors.json"), JSON.stringify(entities.connectors), {
        mode: 0o600,
      });
      result = { success: true };
    } else if (parts[0] === "connectors" && parts[1] === "config" && opts.method === "GET") {
      const { createMcpStore } = await import("../tools/mcp-store.mjs");
      result = await createMcpStore(dir).getDocument();
    } else if (parts[0] === "workspaces") result = [{ path: dir }];
    else if (parts[0] === "sessions" && parts[2] === "messages") result = [];
    else if (parts[0] === "sessions" && parts[2] === "events") result = [];
    else {
      const list = entities[parts[0]];
      if (!list) {
        status = 404;
        result = { error: "missing" };
      } else if (opts.method === "GET")
        result = parts[1] ? list.find((x) => x.id === parts[1]) : list;
      else if (opts.method === "POST") {
        result = { ...body, id: "new" + list.length };
        list.push(result);
      } else if (opts.method === "PUT") {
        result = { ...(list.find((x) => x.id === parts[1]) || {}), ...body, id: parts[1] };
        const i = list.findIndex((x) => x.id === parts[1]);
        if (i < 0) list.push(result);
        else list[i] = result;
      } else if (opts.method === "DELETE") {
        entities[parts[0]] = list.filter((x) => x.id !== parts[1]);
        result = { ok: true };
      }
    }
    return { ok: status === 200, status, json: async () => result };
  };
  return {
    dir,
    calls,
    events,
    entities,
    options: {
      origin: "http://localhost:1234",
      dataDir: dir,
      homeDir,
      fetchImpl,
      emit: (channel, result) => events.push({ channel, result }),
    },
  };
}
test("original calendar automation binds model workspace skills and exposes real run history", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const result = await d("automation:update", [
    {
      mode: "suggested create",
      name: "Daily",
      prompt: "实际任务",
      scheduleType: "recurring",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      status: "ACTIVE",
      cwds: [f.dir],
      modelId: "custom-local:my-model",
      skills: ["分析"],
      expertId: "e1",
    },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.automation.model, "my-model");
  assert.deepEqual(result.automation.skillIds, ["s1"]);
  assert.equal(result.automation.workspace, f.dir);
  assert.equal(result.automation.mode, "craft");
  f.entities.runs.push({
    id: "run1",
    automationId: result.automation.id,
    sessionId: "session1",
    status: "completed",
    output: "真实输出",
    createdAt: "2026-10-13T01:00:00Z",
    finishedAt: "2026-10-13T01:01:00Z",
  });
  const snapshot = await d("automation:getSnapshot");
  assert.deepEqual(snapshot.automations[0].cwds, [f.dir]);
  assert.equal(snapshot.inbox[0].runs[0].conversationId, "session1");
  assert.equal(snapshot.inbox[0].summary, "真实输出");
  assert.equal(snapshot.inbox[0].success, true);
  assert.deepEqual(await d("automation:archiveInboxItem", ["run1"]), { success: true });
  const archived = (await createDispatcher(f.options)("automation:getSnapshot")).inbox[0];
  assert.equal(archived.archived, true);
  assert.equal(archived.summary, "真实输出");
  assert.equal(archived.runs[0].conversationId, "session1");
  await assert.rejects(d("automation:archiveInboxItem", ["missing"]), /找不到/);
  f.entities.runs.push({ id: "busy", status: "awaiting_approval" });
  await assert.rejects(d("automation:archiveInboxItem", ["busy"]), /不能归档/);
  await assert.rejects(
    d("automation:update", [{ name: "Wrong", prompt: "test", skills: ["missing"] }]),
    /找不到/,
  );
  await assert.rejects(
    d("automation:update", [{ name: "Wrong", prompt: "test", cwds: [f.dir, "/second"] }]),
    /工作目录不存在/,
  );
});
test("local account persists and provides no vendor token or paid entitlement", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    account = await d("auth:getAccount");
  assert.match(account.uid, /^local:/);
  assert.equal(account.isLocal, true);
  assert.equal(account.editionType, undefined);
  assert.equal(await d("auth:getToken"), null);
  await d("auth:updateAccountNickname", ["用户甲"]);
  assert.equal((await createDispatcher(f.options)("auth:getAccount")).nickname, "用户甲");
});
test("original model settings contract persists secret but masks reads", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const result = await d("config:saveLocalCustomModel", [
    {
      model: {
        id: "m2",
        url: "http://localhost:11434/v1",
        apiKey: "private-test-key",
        supportsToolCall: false,
      },
    },
  ]);
  assert.equal(result.models.find((x) => x.id === "m2").apiKey, undefined);
  assert.equal(result.models.find((x) => x.id === "m2").apiKeySet, true);
  assert.equal(f.calls.find((x) => x.method === "PUT").body.supportsTools, false);
  const product = await d("config:getProductConfiguration");
  assert(product.models.some((m) => m.id === "custom-local:m2"));
  assert.equal(product.galileo.enabled, false);
});
test("expert and skill shapes adapt backend content and session metadata", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  assert.equal((await d("expert:getExpert", [{ expertId: "e1" }])).expert.prompt.zh, "正确开发");
  assert.equal((await d("skill:list")).results[0].filePath, "local-skill:s1");
  await d("skill:toggle", [{ filePath: "local-skill:s1", enabled: false }]);
  assert.equal(f.entities.skills[0].enabled, false);
  const session = await d("session:create", [
    { cwd: f.dir, config: { model: "custom-local:local-model", expertId: "e1", mode: "craft" } },
  ]);
  assert.equal(session.cwd, f.dir);
  assert.equal(session.config.expertId, "e1");
  assert(f.events.some((e) => e.channel === "session:upserted"));
});
test("unknown capabilities fail explicitly, not empty success", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await assert.rejects(
    d("share:createLink", [{}]),
    (e) => e.code === "LOCAL_CAPABILITY_UNAVAILABLE",
  );
});

test("chat translates real SSE text, tool and approval into original scoped session events", async () => {
  const f = await fixture(),
    backendFetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return backendFetch(url, options);
    const packets = [
      ["delta", { text: "你好" }],
      ["tool", { name: "workspace_write", args: { path: "example.txt", content: "test" } }],
      [
        "approval",
        {
          id: "approval-1",
          name: "workspace_write",
          args: { path: "example.txt", content: "test" },
        },
      ],
      ["tool_result", { name: "workspace_write", result: "Written" }],
      ["done", { message: { content: "你好" } }],
    ];
    const bytes = new TextEncoder().encode(
      packets
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
        .join(""),
    );
    return {
      ok: true,
      body: (async function* () {
        yield bytes.slice(0, 15);
        yield bytes.slice(15);
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  const result = await d("session:sendMessage", [
    session.sessionId,
    [{ type: "text", text: "开始工作" }],
  ]);
  assert.equal(result.stopReason, "end_turn");
  const permission = f.events.find((e) => e.result?.type === "permissionRequest").result;
  f.entities.approvals = [];
  await d("sandbox:respondToIntercept", [
    { sessionId: session.sessionId, requestId: "approval-1", choice: "allow_once" },
  ]);
  const resolved = f.events.find((e) => e.result?.type === "permissionResolved").result;
  assert.equal(resolved.toolCallId, permission.toolCallId);
  assert.notEqual(resolved.toolCallId, resolved.requestId);
  assert.equal(
    f.events.find((e) => e.channel === "sandbox-intercept-resolved").result.toolCallId,
    permission.toolCallId,
  );
  assert(!f.events.some((e) => e.result?.update?.sessionUpdate === "user_message_chunk"));
  const scoped = f.events
    .filter((e) => e.channel === "session:event:" + session.sessionId)
    .map((e) => e.result);
  assert(
    scoped.some(
      (e) => e.update?.sessionUpdate === "agent_message_chunk" && e.update.content.text === "你好",
    ),
  );
  assert(
    scoped.some(
      (e) =>
        e.type === "permissionRequest" &&
        e.requestId === "approval-1" &&
        e.request.toolCall.toolCallId,
    ),
  );
  assert(scoped.some((e) => e.type === "promptResponse"));
  assert.equal(
    scoped.find((e) => e.type === "permissionRequest").request.toolCall._meta[
      "codebuddy.ai/toolName"
    ],
    "Write",
  );
  assert.equal(f.entities.sessions[0].status, "completed");
  assert.equal(f.entities.sessions[0].pendingInputKind, null);
  assert.deepEqual(
    scoped.filter((e) => e.type === "sessionStatusUpdate").map((e) => e.status),
    ["running", "pending", "running", "completed", "completed"],
  );
  await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "第二次" }]]);
  assert.equal(f.entities.sessions[0].status, "completed");
});

test("personalization identity files are independent local files and affect backend memory", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await d("identity:updateUserCallName", ["同事"]);
  await d("identity:updateAiName", ["伙伴"]);
  await d("identity:updateSoulBody", ["回答简洁，按事实办事"]);
  await d("identity:updateMemoryBody", ["项目使用 Node.js"]);
  const result = await d("identity:getLocalMemoryFiles");
  assert.equal(result.userCallName.value, "同事");
  assert.equal(result.aiName.value, "伙伴");
  assert.equal(result.soul.content, "回答简洁，按事实办事");
  assert.equal(result.memory.content, "项目使用 Node.js");
  assert.equal(
    await fs.readFile(path.join(f.dir, "local-memory", "MEMORY.md"), "utf8"),
    "项目使用 Node.js",
  );
  assert.equal(f.entities.memories.length, 4);
  assert.equal((await d("identity:getName")).name, "伙伴");
});

test("original workspace hooks receive string list and path keyed existence map", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  assert.deepEqual(await d("storage:getWorkspaces"), [f.dir]);
  assert.deepEqual(await d("workspace:checkPathsExist", [[f.dir, path.join(f.dir, "not-there")]]), {
    [f.dir]: true,
    [path.join(f.dir, "not-there")]: false,
  });
  assert.equal((await d("workspace:getCurrent")).cwd, f.dir);
});

test("tool result errors and denied execution never render as completed", async () => {
  const f = await fixture(),
    backendFetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return backendFetch(url, options);
    const packets = [
      ["tool", { name: "workspace_write", args: {} }],
      ["tool_result", { name: "workspace_write", result: { error: "Write failed" } }],
      ["tool", { name: "shell_execute", args: {} }],
      ["tool_result", { name: "shell_execute", result: "Permission denied by user" }],
      ["done", {}],
    ];
    const bytes = new TextEncoder().encode(
      packets
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
        .join(""),
    );
    return {
      ok: true,
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "执行" }]]);
  const updates = f.events
    .filter((e) => e.result?.update?.sessionUpdate === "tool_call_update")
    .map((e) => e.result.update);
  assert.equal(updates.length, 2);
  assert(updates.every((update) => update.status === "failed"));
});

test("independent local license snapshot supports own provider without vendor entitlement", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    snapshot = await d("license:getSnapshot");
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.status, "not_applicable");
  assert.equal(snapshot.managed, false);
  assert.equal((await d("config:getProductConfiguration")).deploymentType, "SaaS");
  assert.equal((await d("auth:getAccount")).editionType, undefined);
});

test("session launch config mutation persists real binding and reports epoch", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  const result = await d("session:updateConfig", [
    session.sessionId,
    {
      mode: "ask",
      model: "custom-local:m2",
      expertId: "e1",
      skillIds: ["s1"],
      systemPrompt: "遵循本地模板",
    },
    f.dir,
    {},
  ]);
  assert.equal(result.configUpdateApplied, true);
  assert.equal(result.modeEpoch, 1);
  assert.equal(result.config.mode, "ask");
  assert.equal(result.config.expertId, "e1");
  const stored = f.entities.sessions.find((item) => item.id === session.sessionId);
  assert.equal(stored.model, "m2");
  assert.equal(stored.systemPrompt, "遵循本地模板");
  assert.deepEqual(stored.skillIds, ["s1"]);
  assert.equal(result.config.permissionMode, "default");
  assert.equal(result.config.useSandboxCLI, false);
  await d("session:setConfigOption", [session.sessionId, "reasoning_effort", "high"]);
  assert.equal(f.entities.sessions[0].config.reasoning_effort, "high");
});

test("session manager list has agents envelope and known renderer approval tool identities", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  const result = await d("session:list", [{ userId: (await d("auth:getAccount")).uid }]);
  assert(Array.isArray(result.agents));
  assert.equal(result.agents[0].id, session.sessionId);
  assert.equal(result.agents[0].cwd, f.dir);
});

test("unknown approval tools use honest generic permission card and retain actual audit identity", async () => {
  const f = await fixture(),
    backendFetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return backendFetch(url, options);
    const packets = [
      ["tool", { name: "mcp_dispatch", args: { server: "local", tool: "inspect" } }],
      [
        "approval",
        { id: "mcp-1", name: "mcp_dispatch", args: { server: "local", tool: "inspect" } },
      ],
      ["tool_result", { name: "mcp_dispatch", result: { error: "denied" } }],
      ["done", {}],
    ];
    const bytes = new TextEncoder().encode(
      packets
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
        .join(""),
    );
    return {
      ok: true,
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "检查" }]]);
  const permission = f.events.find((event) => event.result?.type === "permissionRequest").result
    .request.toolCall;
  assert.equal(permission._meta["codebuddy.ai/toolName"], "mcp_dispatch");
  assert.equal(permission._meta["codebuddy.ai/localToolName"], "mcp_dispatch");
  assert.equal(permission._meta["codebuddy.ai/sandboxIntercept"], true);
  assert.equal(permission._meta["codebuddy.ai/interceptType"], "application-permission");
  assert.match(permission._meta["codebuddy.ai/description"], /不提供操作系统沙箱隔离/);
});

test("pending approvals replay uses same Write and Bash semantics and actual file input", async () => {
  const f = await fixture(),
    backendFetch = f.options.fetchImpl;
  let pending = [];
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/approvals")
      ? { ok: true, json: async () => pending }
      : backendFetch(url, options);
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  pending = [
    {
      id: "p1",
      sessionId: session.sessionId,
      name: "workspace_write",
      args: { path: "a.txt", content: "a" },
    },
    { id: "p2", sessionId: session.sessionId, name: "shell_execute", args: { command: "pwd" } },
    { id: "p3", sessionId: session.sessionId, name: "mcp_dispatch", args: { tool: "read" } },
  ];
  await d("session:notifyListenerReady", [session.sessionId]);
  const approvals = f.events
    .filter((event) => event.result?.type === "permissionRequest")
    .map((event) => event.result.request.toolCall);
  assert.equal(approvals[0]._meta["codebuddy.ai/toolName"], "Write");
  assert.equal(approvals[0]._meta["codebuddy.ai/sandboxIntercept"], true);
  assert.equal(approvals[0]._meta["codebuddy.ai/operation"], "write_file");
  assert.equal(approvals[0]._meta["codebuddy.ai/target"], "a.txt");
  assert.equal(approvals[0].rawInput.file_path, "a.txt");
  assert.equal(approvals[1]._meta["codebuddy.ai/toolName"], "Bash");
  assert.equal(approvals[1].rawInput.command, "pwd");
  assert.equal(approvals[2]._meta["codebuddy.ai/sandboxIntercept"], true);
});

test("history boundaries are separate from real messages and load reports replay complete", async () => {
  const f = await fixture(),
    backendFetch = f.options.fetchImpl;
  const history = [
    { id: "user-history", role: "user", content: "第一条真实用户消息" },
    { id: "assistant-history", role: "assistant", content: "最后一条真实助手消息" },
  ];
  f.options.fetchImpl = async (url, options) => {
    if (url.endsWith("/messages")) return { ok: true, json: async () => history };
    if (url.endsWith("/api/approvals")) return { ok: true, json: async () => [] };
    return backendFetch(url, options);
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  const loaded = await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  assert.equal(loaded.rendererHistoryReplayComplete, true);
  const updates = f.events.filter((event) => event.result?.update).map((event) => event.result);
  assert.equal(updates[0]._meta["codebuddy.ai/historyReplay"], "start");
  assert.equal(updates.at(-1)._meta["codebuddy.ai/historyReplay"], "end");
  assert.equal(updates[0].update.sessionUpdate, "session_info_update");
  assert.equal(updates.at(-1).update.sessionUpdate, "session_info_update");
  assert.equal(updates[0].update.content, undefined);
  assert.equal(updates.at(-1).update.content, undefined);
  const realMessages = updates.filter(
    (event) => !["start", "end"].includes(event._meta["codebuddy.ai/historyReplay"]),
  );
  assert.deepEqual(
    realMessages.map((event) => event.update.content.text),
    history.map((message) => message.content),
  );
  assert.deepEqual(
    realMessages.map((event) => event.update._meta["codebuddy.ai/messageId"]),
    history.map((message) => message.id),
  );
  f.events.length = 0;
  await d("session:notifyListenerReady", [session.sessionId]);
  assert.equal(f.events.filter((event) => event.result?.update?.content?.text).length, 2);
});

test("desktop personalization reaches actual backend model context and clears old preference", async () => {
  const http = require("node:http");
  const { createAppServer } = await import("../server/app.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-preference-integration-"));
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  const backend = createAppServer({ dataDir: dir });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (server) => new Promise((resolve) => server.close(resolve));
  await listen(model);
  await listen(backend);
  const origin = "http://127.0.0.1:" + backend.address().port;
  try {
    const configuration = await fetch(origin + "/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:" + model.address().port + "/v1",
        model: "preference-test",
        workspace: dir,
      }),
    });
    assert(configuration.ok);
    const d = createDispatcher({ origin, dataDir: dir });
    await d("config:set", [
      "personalization",
      { toneStyle: "efficient", customPrompt: "桌面验收偏好：回答保持简洁。" },
    ]);
    const session = await d("session:create", [{ cwd: dir, config: { mode: "ask" } }]);
    await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "第一问" }]]);
    assert.match(requests[0].messages[0].content, /桌面验收偏好：回答保持简洁/);
    assert.match(requests[0].messages[0].content, /简洁高效/);
    await d("config:set", ["personalization", { toneStyle: "socratic", customPrompt: "" }]);
    await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "引导我思考" }]]);
    assert.match(requests[1].messages[0].content, /启发引导，用提问引导思考、授人以渔/);
    assert.doesNotMatch(requests[1].messages[0].content, /socratic|简洁高效|桌面验收偏好/);
    await d("config:set", ["personalization", { toneStyle: "", customPrompt: "" }]);
    await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "第二问" }]]);
    assert.doesNotMatch(requests[2].messages[0].content, /桌面验收偏好|简洁高效|启发引导/);
  } finally {
    await close(backend);
    await close(model);
  }
});

test("assistant initialization reports independent disconnected states with original field shapes", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  assert.deepEqual((await d("claw:getChannelStatus")).statusMap, {});
  assert.deepEqual((await d("claw:getSavedChannelConfigs")).configs, {});
  assert.equal((await d("claw:getWecomEnabled")).enabled, false);
  assert.equal((await d("claw:getWechatmpEnabled")).enabled, false);
  assert.equal((await d("claw:getWechatmpArtifactUploadEnabled")).enabled, false);
  assert.equal((await d("claw:getIsIOAMachine")).isIOAMachine, false);
  assert.equal((await d("claw:getIOAImOverride")).allowNonTencentIM, false);
  assert.equal((await d("claw:getAutomationWecomPushConfig")).enabled, false);
  assert.equal((await d("claw:wechatkfGetBindStatus")).bound, false);
  await assert.rejects(
    d("claw:registerChannel", [{ channelType: "wechat" }]),
    (error) => error.code === "LOCAL_CAPABILITY_UNAVAILABLE",
  );
});

test("bundled runtime policy only exposes packaged Node and saves the applied backend value", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  assert.deepEqual(await d("window:getBundledRuntimeConfig"), {
    enabled: true,
    tools: { node: true, python: false, gitBash: false },
  });
  const next = { enabled: true, tools: { node: false, python: false, gitBash: false } };
  assert.deepEqual(await d("window:saveBundledRuntimeConfig", [next]), next);
  assert.deepEqual(await d("window:getBundledRuntimeConfig"), next);
  await assert.rejects(
    d("window:saveBundledRuntimeConfig", [
      { enabled: true, tools: { node: true, python: true, gitBash: false } },
    ]),
    (error) => error.code === "LOCAL_CAPABILITY_UNAVAILABLE",
  );
  assert.equal(
    f.calls.filter((call) => call.method === "PUT" && call.body.bundledRuntime).length,
    1,
  );
});

test("manual skill selection preserves canonical binding even when automatic model invocation is disabled", async () => {
  const f = await fixture();
  f.entities.skills.push({
    id: "canonical-1",
    name: "这是标题而非名称",
    slug: "old-slug",
    source: "bundled-client-resource",
    enabled: false,
    content: '---\nname: "actual-skill"\ndescription: sample\n---\n# 标题\n真实技能指令',
  });
  const originalFetch = f.options.fetchImpl,
    chatBodies = [];
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return originalFetch(url, options);
    chatBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode(
          'event: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n',
        );
      })(),
    };
  };
  const d = createDispatcher(f.options);
  const summary = (await d("skill:list")).results.find((skill) => skill.id === "canonical-1");
  assert.equal(summary.name, "actual-skill");
  assert.equal(summary.disableModelInvocation, true);
  assert.equal(summary.displayName, "这是标题而非名称");
  assert.equal(summary.source, "userSettings");
  assert.equal(summary.provenance, "bundled-client-resource");
  const session = await d("session:create", [{ cwd: f.dir, config: { mode: "ask" } }]);
  await d("session:sendMessage", [
    session.sessionId,
    [
      { type: "resource_link", uri: "skill://actual-skill", name: "actual-skill" },
      { type: "text", text: "请按技能办事" },
    ],
  ]);
  assert.deepEqual(chatBodies[0].skillIds, ["canonical-1"]);
  assert.match(chatBodies[0].message, /使用技能：actual-skill/);
});

test("ambiguous and unknown skill references fail before model request instead of silently selecting", async () => {
  const f = await fixture(),
    originalFetch = f.options.fetchImpl;
  f.entities.skills.push(
    ...["a", "b"].map((id) => ({
      id,
      name: "标题" + id,
      content: "---\nname: repeated-skill\n---\n" + id,
      enabled: true,
    })),
  );
  let chats = 0;
  f.options.fetchImpl = async (url, options) => {
    if (url.endsWith("/chat")) chats++;
    return originalFetch(url, options);
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "ask" } }]);
  await assert.rejects(
    d("session:sendMessage", [
      session.sessionId,
      [
        { type: "resource_link", uri: "skill://repeated-skill" },
        { type: "text", text: "执行" },
      ],
    ]),
    (error) => error.code === "LOCAL_SKILL_AMBIGUOUS",
  );
  await assert.rejects(
    d("session:sendMessage", [
      session.sessionId,
      [
        { type: "resource_link", uri: "skill://no-such-skill" },
        { type: "text", text: "执行" },
      ],
    ]),
    (error) => error.code === "LOCAL_SKILL_NOT_FOUND",
  );
  assert.equal(chats, 0);
});

test("skill resource link injects exact selected skill content into real backend model system message", async () => {
  const http = require("node:http");
  const { createAppServer } = await import("../server/app.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-skill-integration-"));
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "skill ok" } }] }));
  });
  const backend = createAppServer({ dataDir: dir });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (server) => new Promise((resolve) => server.close(resolve));
  await listen(model);
  await listen(backend);
  const origin = "http://127.0.0.1:" + backend.address().port;
  try {
    await fetch(origin + "/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:" + model.address().port + "/v1",
        model: "skill-test",
        workspace: dir,
      }),
    });
    const insert = (skill) =>
      fetch(origin + "/api/skills/" + skill.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skill),
      });
    await insert({
      id: "chosen",
      name: "展示标题",
      slug: "wrong-slug",
      content: "---\nname: precise-skill\n---\n唯一真实技能指令：验收标记123",
      enabled: true,
    });
    await insert({
      id: "other",
      name: "其他技能",
      content: "---\nname: other-skill\n---\n未选技能不应出现在上下文456",
      enabled: true,
    });
    const d = createDispatcher({ origin, dataDir: dir });
    const session = await d("session:create", [{ cwd: dir, config: { mode: "ask" } }]);
    await d("session:sendMessage", [
      session.sessionId,
      [
        { type: "resource_link", uri: "skill://precise-skill", name: "precise-skill" },
        { type: "text", text: "按此技能执行" },
      ],
    ]);
    assert.match(requests[0].messages[0].content, /唯一真实技能指令：验收标记123/);
    assert.doesNotMatch(requests[0].messages[0].content, /未选技能不应出现在上下文456/);
    const slashSession = await d("session:create", [{ cwd: dir, config: { mode: "ask" } }]);
    await d("session:sendMessage", [
      slashSession.sessionId,
      [
        {
          type: "resource_link",
          uri: "command://precise-skill",
          name: "/precise-skill",
          title: "/precise-skill",
          _meta: {
            mentionType: "skill",
            commandName: "precise-skill",
            isCommand: true,
            isSkill: true,
            type: "command",
            attachedSkill: { name: "precise-skill", description: "真实技能" },
          },
        },
        { type: "text", text: "验收原桌面 slash 技能" },
      ],
    ]);
    assert.match(requests[1].messages[0].content, /唯一真实技能指令：验收标记123/);
    assert.doesNotMatch(requests[1].messages[0].content, /未选技能不应出现在上下文456/);
    const saved = await (await fetch(origin + "/api/sessions/" + slashSession.sessionId)).json();
    assert.deepEqual(saved.skillIds, ["chosen"]);
    const messages = await (
      await fetch(origin + "/api/sessions/" + slashSession.sessionId + "/messages")
    ).json();
    const userMessages = messages.filter((message) => message.role === "user");
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0].content, /验收原桌面 slash 技能/);
  } finally {
    await close(backend);
    await close(model);
  }
});

test("default workspace RPC expands the displayed home location and creates unique real task folders", async () => {
  const f = await fixture(),
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-default-home-")),
    d = createDispatcher({ ...f.options, homeDir });
  const first = await d("workspace:generateDefaultCwd"),
    second = await d("workspace:generateDefaultCwd");
  assert.equal(typeof first, "string");
  assert.equal(path.dirname(first), await fs.realpath(path.join(homeDir, "WorkBuddy")));
  assert.notEqual(first, second);
  assert((await fs.stat(first)).isDirectory());
  assert((await fs.stat(second)).isDirectory());
  await assert.rejects(d("workspace:generateDefaultCwd", [{ root: f.dir }]));
});

test("expert summon returns localized real instructions without fabricating a new session", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const result = await d("expert:summonExpert", [{ expertId: "e1", locale: "zh" }]);
  assert.equal(result.expert.id, "e1");
  assert.equal(result.expert.name, "开发");
  assert.equal(result.expert.profession, "开发");
  assert.equal(result.expert.prompt, "正确开发");
  assert.equal(f.entities.sessions.length, 0);
  const session = await d("session:create", [
    { cwd: f.dir, config: { mode: "craft", expertId: result.expert.id } },
  ]);
  assert.equal(f.entities.sessions[0].expertId, "e1");
  assert.equal(session.config.expertId, "e1");
});

test("original ACP encoded @skill mention resolves canonical skill IDs without slash guessing", async () => {
  const f = await fixture(),
    original = f.options.fetchImpl,
    requests = [];
  f.entities.skills.push({
    id: "codec-skill",
    name: "标题",
    content: '---\nname: "quoted skill"\n---\n精确内容',
    enabled: true,
  });
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return original(url, options);
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode("event: done\ndata: {}\n\n");
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{ cwd: f.dir, config: { mode: "ask" } }]);
  await d("session:sendMessage", [
    session.sessionId,
    [{ type: "text", text: '@skill:"quoted skill" 请执行' }],
  ]);
  assert.deepEqual(requests[0].skillIds, ["codec-skill"]);
  await d("session:sendMessage", [
    session.sessionId,
    [{ type: "text", text: "/quoted-skill 这是普通文本" }],
  ]);
  assert.deepEqual(requests[1].skillIds, []);
});

test("original bundled plugin toggles persist and update actual child skill records", { skip: process.env.WORKBUDDY_PUBLIC_TESTS === "1" ? "Proprietary fixture excluded from public source release" : false }, async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const installed = await d("plugin:getInstalled");
  assert.equal(installed.length, 5);
  const plugin = installed.find((item) => item.skills.length > 0);
  const disabled = await d("plugin:batchToggle", [
    {
      items: [
        {
          pluginName: plugin.name,
          marketplaceName: plugin.marketplaceName,
          scope: "user",
          operation: "disable",
        },
      ],
    },
  ]);
  assert.equal(disabled.success, true);
  assert(
    plugin.skills.every(
      (child) => f.entities.skills.find((s) => s.id === child.id).enabled === false,
    ),
  );
  const restarted = createDispatcher(f.options);
  assert.equal(
    (await restarted("plugin:getInstalled")).find((item) => item.name === plugin.name).enabled,
    false,
  );
  await restarted("plugin:batchToggle", [
    {
      items: [
        {
          pluginName: plugin.name,
          marketplaceName: plugin.marketplaceName,
          scope: "user",
          operation: "enable",
        },
      ],
    },
  ]);
  assert(
    plugin.skills.every(
      (child) => f.entities.skills.find((s) => s.id === child.id).enabled === true,
    ),
  );
  await restarted("plugin:uninstall", [plugin.name, plugin.marketplaceName, "user"]);
  assert.equal((await restarted("plugin:getInstalled")).length, 4);
  await fs.access(plugin.installPath);
  assert(
    plugin.skills.every(
      (child) => f.entities.skills.find((s) => s.id === child.id).enabled === false,
    ),
  );
  await restarted("plugin:install", [[plugin.name], plugin.marketplaceName, "user"]);
  assert.equal((await restarted("plugin:getInstalled")).length, 5);
  assert(
    plugin.skills.every(
      (child) => f.entities.skills.find((s) => s.id === child.id).enabled === true,
    ),
  );
});

test("cancelling a pending Write clears both renderer permission channels and never writes", async () => {
  const http = require("node:http");
  const { createAppServer } = await import("../server/app.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-cancel-write-"));
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    calls++;
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
                  id: "cancel-write",
                  type: "function",
                  function: {
                    name: "workspace_write",
                    arguments: JSON.stringify({ path: "must-not-exist.txt", content: "cancelled" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen(model);
  const dataDir = path.join(dir, "data"),
    server = createAppServer({ dataDir });
  await listen(server);
  const origin = "http://127.0.0.1:" + server.address().port;
  const api = async (route) => (await fetch(origin + "/api" + route)).json();
  const events = [];
  let ready;
  const pending = new Promise((resolve) => {
    ready = resolve;
  });
  const d = createDispatcher({
    origin,
    dataDir,
    emit: (channel, value) => {
      events.push({ channel, value });
      if (value.type === "permissionRequest") ready(value);
    },
  });
  try {
    await fetch(origin + "/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: "http://127.0.0.1:" + model.address().port + "/v1",
        model: "cancel-fixture",
        workspace,
      }),
    });
    const session = await d("session:create", [{ cwd: workspace }]);
    const prompt = d("session:sendMessage", [
      session.sessionId,
      [{ type: "text", text: "Write proof" }],
    ]);
    const stopped = prompt.then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    const timeout = setTimeout(() => ready(null), 5000);
    const permission = await pending;
    clearTimeout(timeout);
    assert(permission);
    await d("session:cancel", [session.sessionId]);
    const outcome = await stopped;
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.response, { stopReason: "cancelled" });
    assert(
      !events.some(
        (e) => e.channel === "session:event:" + session.sessionId && e.value.type === "error",
      ),
    );
    assert.equal((await api("/approvals")).length, 0);
    await assert.rejects(fs.stat(path.join(workspace, "must-not-exist.txt")), { code: "ENOENT" });
    assert.equal(calls, 1);
    assert.equal((await api("/sessions/" + session.sessionId)).status, "cancelled");
    assert(
      events.some(
        (e) =>
          e.channel === "sandbox-intercept-resolved" &&
          e.value.toolCallId === permission.toolCallId,
      ),
    );
    assert(
      events.some(
        (e) =>
          e.value.type === "permissionResolved" &&
          e.value.toolCallId === permission.toolCallId &&
          e.value.decision === "reject_once",
      ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

test("history replay restores distinct completed tool cards, results and denied status", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  const history = [
    { id: "user", role: "user", content: "read twice", createdAt: "2026-10-13T00:00:00Z" },
    { id: "assistant", role: "assistant", content: "done", createdAt: "2026-10-13T00:00:08Z" },
  ];
  const events = [
    {
      id: "read-one",
      event: "tool",
      data: { name: "workspace_read", args: { path: "one.txt" } },
      createdAt: "2026-10-13T00:00:01Z",
    },
    {
      id: "result-one",
      event: "tool_result",
      data: { name: "workspace_read", result: "first" },
      createdAt: "2026-10-13T00:00:02Z",
    },
    {
      id: "read-two",
      event: "tool",
      data: { name: "workspace_read", args: { path: "two.txt" } },
      createdAt: "2026-10-13T00:00:03Z",
    },
    {
      id: "result-two",
      event: "tool_result",
      data: { name: "workspace_read", result: "second" },
      createdAt: "2026-10-13T00:00:04Z",
    },
    {
      id: "write",
      event: "tool",
      data: { name: "workspace_write", args: { path: "deny.txt" } },
      createdAt: "2026-10-13T00:00:05Z",
    },
    {
      id: "denied",
      event: "tool_result",
      data: { name: "workspace_write", result: "Permission denied by user" },
      createdAt: "2026-10-13T00:00:06Z",
    },
    {
      id: "pending",
      event: "tool",
      data: { name: "workspace_write", args: { path: "pending.txt" } },
      createdAt: "2026-10-13T00:00:07Z",
    },
  ];
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/approvals")
      ? { ok: true, json: async () => [] }
      : url.endsWith("/messages")
        ? { ok: true, json: async () => history }
        : url.endsWith("/events")
          ? { ok: true, json: async () => [...events].reverse() }
          : base(url, options);
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  const cards = f.events
    .filter((e) => e.result?.update?.sessionUpdate === "tool_call")
    .map((e) => e.result.update);
  assert.equal(cards.length, 3);
  assert.deepEqual(
    cards.map((c) => c.rawInput.file_path),
    ["one.txt", "two.txt", "deny.txt"],
  );
  assert.deepEqual(
    cards.map((c) => c.status),
    ["completed", "completed", "failed"],
  );
  assert.equal(new Set(cards.map((c) => c.toolCallId)).size, 3);
  assert(cards.every((card) => card._meta["codebuddy.ai/messageId"] === "assistant"));
  const results = f.events
    .filter((e) => e.result?.update?.sessionUpdate === "tool_call_update")
    .map((e) => e.result.update);
  assert.deepEqual(
    results.map((c) => c.rawOutput),
    ["first", "second", "Permission denied by user"],
  );
  assert.deepEqual(
    results.map((c) => c.rawInput.file_path),
    ["one.txt", "two.txt", "deny.txt"],
  );
  assert.deepEqual(
    results.map((c) => c.toolCallId),
    cards.map((c) => c.toolCallId),
  );
  f.events.length = 0;
  await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  assert.deepEqual(
    f.events
      .filter((e) => e.result?.update?.sessionUpdate === "tool_call")
      .map((e) => e.result.update.toolCallId),
    cards.map((c) => c.toolCallId),
  );
});

test("history tool from an interrupted turn never attaches to the next turn answer", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  const messages = [
    { id: "first-user", role: "user", content: "read", createdAt: "2026-10-13T00:00:00Z" },
    { id: "next-user", role: "user", content: "hello", createdAt: "2026-10-13T00:00:03Z" },
    { id: "next-answer", role: "assistant", content: "hello", createdAt: "2026-10-13T00:00:04Z" },
  ];
  const events = [
    {
      id: "start",
      event: "tool",
      data: { name: "workspace_read", args: { path: "first.txt" } },
      createdAt: "2026-10-13T00:00:01Z",
    },
    {
      id: "result",
      event: "tool_result",
      data: { name: "workspace_read", result: "first" },
      createdAt: "2026-10-13T00:00:02Z",
    },
  ];
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/approvals")
      ? { ok: true, json: async () => [] }
      : url.endsWith("/messages")
        ? { ok: true, json: async () => messages }
        : url.endsWith("/events")
          ? { ok: true, json: async () => [...events].reverse() }
          : base(url, options);
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  const card = f.events.find((e) => e.result?.update?.sessionUpdate === "tool_call").result.update;
  assert.equal(
    card._meta["codebuddy.ai/messageId"],
    session.sessionId + ":history-tool-message:start",
  );
  assert.notEqual(card._meta["codebuddy.ai/messageId"], "next-answer");
});

test("history pairs execution IDs without consuming an abandoned same-name tool", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  const events = [
    {
      id: "abandoned",
      event: "tool",
      data: { name: "workspace_read", args: { path: "old.txt" }, toolCallId: "old" },
      createdAt: "2026-10-13T00:00:01Z",
    },
    {
      id: "new",
      event: "tool",
      data: { name: "workspace_read", args: { path: "new.txt" }, toolCallId: "new" },
      createdAt: "2026-10-13T00:00:03Z",
    },
    {
      id: "result",
      event: "tool_result",
      data: { name: "workspace_read", result: "new result", toolCallId: "new" },
      createdAt: "2026-10-13T00:00:04Z",
    },
  ];
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/approvals")
      ? { ok: true, json: async () => [] }
      : url.endsWith("/messages")
        ? { ok: true, json: async () => [] }
        : url.endsWith("/events")
          ? { ok: true, json: async () => [...events].reverse() }
          : base(url, options);
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  const cards = f.events.filter((e) => e.result?.update?.sessionUpdate === "tool_call");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].result.update.rawInput.file_path, "new.txt");
});

test("live same-name tool results preserve execution identity and original inputs", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    const packets = [
      ["tool", { name: "workspace_read", args: { path: "one.txt" }, toolCallId: "one" }],
      ["tool", { name: "workspace_read", args: { path: "two.txt" }, toolCallId: "two" }],
      ["tool_result", { name: "workspace_read", result: "second", toolCallId: "two" }],
      ["tool_result", { name: "workspace_read", result: "first", toolCallId: "one" }],
    ];
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode(
          packets
            .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
            .join(""),
        );
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "read" }]]);
  const updates = f.events.map((e) => e.result?.update).filter(Boolean);
  const starts = updates.filter((e) => e.sessionUpdate === "tool_call");
  const results = updates.filter((e) => e.sessionUpdate === "tool_call_update");
  assert.deepEqual(
    results.map((e) => e.toolCallId),
    [starts[1].toolCallId, starts[0].toolCallId],
  );
  assert.deepEqual(
    results.map((e) => e.rawInput.file_path),
    ["two.txt", "one.txt"],
  );
  assert(results.every((e) => e._meta["codebuddy.ai/toolName"] === "Read"));
});

test("desktop SSE handles byte-split CRLF UTF-8 and a final error without delimiter", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    const bytes = new TextEncoder().encode(
      'event: delta\r\ndata: {"text":"中文回答"}\r\n\r\n' +
        'event: error\r\ndata: {"message":"回答未完成"}',
    );
    return {
      ok: true,
      body: (async function* () {
        for (const byte of bytes) yield Uint8Array.of(byte);
      })(),
    };
  };
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await assert.rejects(
    d("session:sendMessage", [session.sessionId, [{ type: "text", text: "测试" }]]),
    /回答未完成/,
  );
  const text = f.events
    .filter((e) => e.result?.update?.sessionUpdate === "agent_message_chunk")
    .map((e) => e.result.update.content.text)
    .join("");
  assert.equal(text, "中文回答");
  assert(
    f.events.some((e) => e.result?.type === "sessionStatusUpdate" && e.result.status === "failed"),
  );
  assert(
    !f.events.some(
      (e) => e.result?.type === "sessionStatusUpdate" && e.result.status === "completed",
    ),
  );
});

test("legacy same-name history never pairs across a new user turn", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  const messages = [
    { id: "first", role: "user", content: "old", createdAt: "2026-10-13T00:00:00Z" },
    { id: "second", role: "user", content: "new", createdAt: "2026-10-13T00:00:02Z" },
    { id: "answer", role: "assistant", content: "new result", createdAt: "2026-10-13T00:00:05Z" },
  ];
  const events = [
    {
      id: "abandoned",
      event: "tool",
      data: { name: "workspace_read", args: { path: "old.txt" } },
      createdAt: "2026-10-13T00:00:01Z",
    },
    {
      id: "new",
      event: "tool",
      data: { name: "workspace_read", args: { path: "new.txt" } },
      createdAt: "2026-10-13T00:00:03Z",
    },
    {
      id: "result",
      event: "tool_result",
      data: { name: "workspace_read", result: "new result" },
      createdAt: "2026-10-13T00:00:04Z",
    },
  ];
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/approvals")
      ? { ok: true, json: async () => [] }
      : url.endsWith("/messages")
        ? { ok: true, json: async () => messages }
        : url.endsWith("/events")
          ? { ok: true, json: async () => [...events].reverse() }
          : base(url, options);
  const d = createDispatcher(f.options),
    session = await d("session:create", [{}]);
  await d("session:load", [session.sessionId, { forceRendererHistoryReplay: true }]);
  const cards = f.events.filter((e) => e.result?.update?.sessionUpdate === "tool_call");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].result.update.rawInput.file_path, "new.txt");
  assert.equal(cards[0].result.update._meta["codebuddy.ai/messageId"], "answer");
});

test("original skill ZIP contract exports actual content and rejects unrelated directory", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  f.entities.skills = [
    {
      id: "export-proof",
      name: "export-proof",
      content: "---\nname: export-proof\n---\n# 导出资料\n保持完整内容。",
      enabled: true,
    },
  ];
  const result = await d("skill:exportZip", [
    { skillName: "export-proof", skillRootDir: "local-skill:export-proof" },
  ]);
  assert.equal(result.success, true);
  const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)(
    "python3",
    [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.buffer.write(z.read('SKILL.md'))",
      result.zipPath,
    ],
  );
  assert.equal(stdout, f.entities.skills[0].content);
  await assert.rejects(
    d("skill:exportZip", [{ skillName: "export-proof", skillRootDir: f.dir }]),
    /no installed directory/,
  );
});

test("directory skill import preserves references and exports binary resources", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    source = path.join(f.dir, "source");
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: package-proof\n---\nUse references/proof.txt",
  );
  await fs.writeFile(path.join(source, "references/proof.txt"), "WB-SKILL-PACK-831");
  await fs.writeFile(path.join(source, "image.bin"), Buffer.from([0, 255, 17]));
  const installed = await d("skill:installByPath", [
    { folderPath: source, source: "userSettings" },
  ]);
  assert.equal(installed.skillName, "package-proof");
  const root = path.dirname(installed.skill.filePath);
  assert.equal(
    await fs.readFile(path.join(root, "references/proof.txt"), "utf8"),
    "WB-SKILL-PACK-831",
  );
  const result = await d("skill:exportZip", [{ skillName: "package-proof", skillRootDir: root }]);
  const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)(
    "python3",
    [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('image.bin') == bytes([0,255,17]); print(z.read('references/proof.txt').decode())",
      result.zipPath,
    ],
  );
  assert.equal(stdout.trim(), "WB-SKILL-PACK-831");
  await fs.symlink(f.dir, path.join(source, "outside"));
  await assert.rejects(d("skill:installByPath", [{ path: source }]), /links and special files/);
});

test("desktop creates and repairs persisted cwd without replacing conversation bindings", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  f.entities.approvals = [];
  const created = await d("session:create", [{}]);
  assert(path.isAbsolute(created.cwd));
  assert((await fs.stat(created.cwd)).isDirectory());
  const stored = f.entities.sessions.find((s) => s.id === created.sessionId);
  stored.workspace = "";
  stored.skillIds = ["proof"];
  stored.expertId = "existing";
  const repaired = await d("session:get", [created.sessionId]);
  assert(path.isAbsolute(repaired.cwd));
  assert.deepEqual(repaired.skillIds, ["proof"]);
  assert.equal(repaired.expertId, "existing");
  assert.equal((await d("session:get", [created.sessionId])).cwd, repaired.cwd);
});

test("skill import never reports success when requested security scan is unavailable", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await d("skill:list", []);
  const before = [...(f.entities.skills || [])];
  await assert.rejects(
    d("skill:import", [
      { content: "---\nname: requested-scan\n---\nRead only.", securityCheck: true },
    ]),
    (e) => e.code === "LOCAL_SKILL_SCAN_UNAVAILABLE",
  );
  assert.deepEqual(f.entities.skills || [], before);
  const installed = await d("skill:import", [
    { content: "---\nname: no-scan\n---\nRead only.", securityCheck: false },
  ]);
  assert.equal(installed.success, true);
  assert.equal(installed.skillName, "no-scan");
});

test("original ZIP upload imports one skill with references and rejects multiple packages", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    zip = path.join(f.dir, "skill.zip");
  const { createExpertZip } = require("./expert-zip.cjs");
  await fs.writeFile(
    zip,
    createExpertZip(
      new Map([
        ["package/SKILL.md", Buffer.from("---\nname: zip-proof\n---\nRead references/proof.txt")],
        ["package/references/proof.txt", Buffer.from("ZIP_REFERENCE_PROOF")],
      ]),
    ),
  );
  const installed = await d("skill:import", [{ folderPath: zip, securityCheck: false }]);
  assert.equal(installed.skillName, "zip-proof");
  assert.equal(
    await fs.readFile(
      path.join(path.dirname(installed.skill.filePath), "references/proof.txt"),
      "utf8",
    ),
    "ZIP_REFERENCE_PROOF",
  );
  await fs.writeFile(
    zip,
    createExpertZip(
      new Map([
        ["one/SKILL.md", Buffer.from("one")],
        ["two/SKILL.md", Buffer.from("two")],
      ]),
    ),
  );
  await assert.rejects(
    d("skill:import", [{ folderPath: zip, securityCheck: false }]),
    /exactly one skill/,
  );
});

test("duplicate skill import requires explicit overwrite and preserves the selected skill ID", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const first = await d("skill:import", [{ content: "---\nname: same-proof\n---\nfirst" }]);
  const rejected = await d("skill:import", [{ content: "---\nname: same-proof\n---\nsecond" }]);
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorKey, "duplicateSkillName");
  assert.equal(
    f.entities.skills.filter((s) => s.id === first.skill.id)[0].content,
    "---\nname: same-proof\n---\nfirst",
  );
  const replaced = await d("skill:import", [
    { content: "---\nname: same-proof\n---\nsecond", overwrite: true },
  ]);
  assert.equal(replaced.skill.id, first.skill.id);
  assert.equal(replaced.skill.content, "---\nname: same-proof\n---\nsecond");
  assert.equal(f.entities.skills.filter((s) => s.name === "same-proof").length, 1);
});

test("original skill disable contract is idempotent and does not invert on repeated calls", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  f.entities.skills = [
    {
      id: "toggle-proof",
      name: "toggle-proof",
      content: "---\nname: toggle-proof\n---\nRead only.",
      enabled: true,
    },
  ];
  const filePath = "local-skill:toggle-proof";
  await d("skill:toggle", [{ filePath, disable: true }]);
  await d("skill:toggle", [{ filePath, disable: true }]);
  let skill = (await d("skill:list", [])).results.find((s) => s.id === "toggle-proof");
  assert.equal(skill.enabled, false);
  assert.equal(skill.disableModelInvocation, true);
  await d("skill:toggle", [{ filePath, disable: false }]);
  await d("skill:toggle", [{ filePath, disable: false }]);
  skill = (await d("skill:list", [])).results.find((s) => s.id === "toggle-proof");
  assert.equal(skill.enabled, true);
  assert.equal(skill.disableModelInvocation, false);
  await assert.rejects(d("skill:toggle", [{ filePath, disable: "true" }]), /boolean/);
});

test("local skill switch updates installed frontmatter and preserves instructions", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    source = path.join(f.dir, "switch-source");
  await fs.mkdir(source);
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: file-switch-proof\nuser-invocable: true\n---\nKEEP_INSTRUCTIONS",
  );
  const installed = await d("skill:installByPath", [{ folderPath: source }]);
  await d("skill:toggle", [{ filePath: installed.skill.filePath, disable: true }]);
  let current = await d("skill:content", [{ id: installed.skill.id }]);
  assert.equal(
    require("./skill-metadata.cjs").skillFlags(current.content).disableModelInvocation,
    true,
  );
  assert(current.content.endsWith("KEEP_INSTRUCTIONS"));
  await d("skill:toggle", [{ filePath: installed.skill.filePath, disable: false }]);
  current = await d("skill:content", [{ id: installed.skill.id }]);
  assert.equal(
    require("./skill-metadata.cjs").skillFlags(current.content).disableModelInvocation,
    false,
  );
  assert.equal(require("./skill-metadata.cjs").skillFlags(current.content).userInvocable, true);
});

test("failed skill toggle rolls back file and successful export preserves invocation flags", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    source = path.join(f.dir, "rollback-source");
  await fs.mkdir(source);
  const original = "---\nname: rollback-proof\nuser-invocable: true\n---\nKEEP_BODY";
  await fs.writeFile(path.join(source, "SKILL.md"), original);
  const installed = await d("skill:installByPath", [{ folderPath: source }]);
  const base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (url.endsWith("/skills/" + installed.skill.id) && options.method === "PUT")
      return { ok: false, json: async () => ({ error: "simulated persistence failure" }) };
    return base(url, options);
  };
  const failing = createDispatcher(f.options);
  await assert.rejects(
    failing("skill:toggle", [{ filePath: installed.skill.filePath, disable: true }]),
    /simulated persistence failure/,
  );
  assert.equal(await fs.readFile(installed.skill.filePath, "utf8"), original);
  assert.equal(f.entities.skills.find((s) => s.id === installed.skill.id).enabled, true);
  f.options.fetchImpl = base;
  const success = createDispatcher(f.options);
  await success("skill:toggle", [{ filePath: installed.skill.filePath, disable: true }]);
  const result = await success("skill:exportZip", [
    { skillName: "rollback-proof", skillRootDir: path.dirname(installed.skill.filePath) },
  ]);
  const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)(
    "python3",
    [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.buffer.write(z.read('SKILL.md'))",
      result.zipPath,
    ],
  );
  assert.equal(require("./skill-metadata.cjs").skillFlags(stdout).disableModelInvocation, true);
  assert.equal(require("./skill-metadata.cjs").skillFlags(stdout).userInvocable, true);
  assert(stdout.endsWith("KEEP_BODY"));
  const reinstalled = await success("skill:import", [
    { folderPath: result.zipPath, securityCheck: false, overwrite: true },
  ]);
  assert.equal(reinstalled.skill.id, installed.skill.id);
  assert.equal(reinstalled.skill.disableModelInvocation, true);
  assert.equal(reinstalled.skill.enabled, false);
  assert.equal(reinstalled.skill.userInvocable, true);
});

test("failed model save leaves model list unchanged and no-key model clears previous credentials", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, opts) =>
    url.endsWith("/api/config") && opts.method === "PUT"
      ? { ok: false, json: async () => ({ error: "model config save failed" }) }
      : base(url, opts);
  const d = createDispatcher(f.options);
  await assert.rejects(
    d("config:saveLocalCustomModel", [
      { model: { id: "failed-provider", url: "http://localhost:12345/v1" } },
    ]),
    /model config save failed/,
  );
  assert(
    !(await d("config:getLocalCustomModels", [])).models.some((m) => m.id === "failed-provider"),
  );
  f.options.fetchImpl = base;
  const success = createDispatcher(f.options);
  await success("config:saveLocalCustomModel", [
    { model: { id: "with-key", url: "http://localhost:11111/v1", apiKey: "test-key" } },
  ]);
  await success("config:saveLocalCustomModel", [
    { model: { id: "no-key", url: "http://localhost:22222/v1" } },
  ]);
  const writes = f.calls.filter((c) => c.method === "PUT");
  assert.equal(writes.at(-1).body.apiKey, "");
  await success("config:deleteLocalCustomModel", ["no-key"]);
  assert.equal(f.calls.filter((c) => c.method === "PUT").at(-1).body.apiKey, "test-key");
});

test("model settings disk failure happens before backend mutation and restores in-memory models", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await d("config:getLocalCustomModels", []);
  const filename = path.join(f.dir, "desktop-settings.json");
  await fs.rename(filename, filename + ".before");
  await fs.mkdir(filename);
  const putsBefore = f.calls.filter((c) => c.method === "PUT").length;
  await assert.rejects(
    d("config:saveLocalCustomModel", [
      { model: { id: "disk-failed", url: "http://localhost:12345/v1" } },
    ]),
  );
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, putsBefore);
  assert(!(await d("config:getLocalCustomModels", [])).models.some((m) => m.id === "disk-failed"));
  await fs.rename(filename, filename + ".blocked-directory");
  await fs.rename(filename + ".before", filename);
  const restored = JSON.parse(await fs.readFile(filename, "utf8"));
  assert(!restored.models.some((m) => m.id === "disk-failed"));
});

test("concurrent model saves serialize and preserve both models after a delayed provider update", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let release, started;
  const gate = new Promise((r) => (release = r)),
    begin = new Promise((r) => (started = r));
  let puts = 0;
  f.options.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/config") && options.method === "PUT") {
      puts++;
      if (puts === 1) {
        started();
        await gate;
      }
    }
    return base(url, options);
  };
  const d = createDispatcher(f.options);
  const first = d("config:saveLocalCustomModel", [
    { model: { id: "first-model", url: "http://localhost:11111/v1" } },
  ]);
  await begin;
  const second = d("config:saveLocalCustomModel", [
    { model: { id: "second-model", url: "http://localhost:22222/v1" } },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.equal(puts, 1);
  release();
  await Promise.all([first, second]);
  const models = (await d("config:getLocalCustomModels", [])).models;
  assert(models.some((m) => m.id === "first-model"));
  assert(models.some((m) => m.id === "second-model"));
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, "desktop-settings.json"), "utf8"));
  assert.equal(saved.models.length, 2);
});

test("concurrent shared settings writes survive reload without losing unrelated values", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await Promise.all([
    d("config:saveLocalCustomModel", [
      { model: { id: "shared-model", url: "http://localhost:12345/v1" } },
    ]),
    d("auth:savePendingInput", [{ text: "PENDING_PROOF" }]),
    ...Array.from({ length: 12 }, (_, i) =>
      d("config:set", [{ key: "concurrent-" + i, value: "value-" + i }]),
    ),
  ]);
  const disk = JSON.parse(await fs.readFile(path.join(f.dir, "desktop-settings.json"), "utf8"));
  assert(disk.models.some((m) => m.id === "shared-model"));
  assert.equal(disk.pendingInput.text, "PENDING_PROOF");
  for (let i = 0; i < 12; i++) assert.equal(disk.values["concurrent-" + i], "value-" + i);
  const reopened = createDispatcher(f.options);
  assert.equal((await reopened("auth:loadPendingInput", [])).text, "PENDING_PROOF");
  assert(
    (await reopened("config:getLocalCustomModels", [])).models.some((m) => m.id === "shared-model"),
  );
  for (let i = 0; i < 12; i++)
    assert.equal(await reopened("config:get", [{ key: "concurrent-" + i }]), "value-" + i);
});

test("local model display label is readable while exact model ID and endpoint remain unchanged", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    model = "/Users/example/models/qwen3-8b-4bit";
  f.options.fetchImpl = async (url, options) =>
    url.endsWith("/api/config") && options.method === "GET"
      ? {
          ok: true,
          json: async () => ({ model, baseURL: "http://127.0.0.1:18725/v1", supportsTools: true }),
        }
      : base(url, options);
  const d = createDispatcher(f.options),
    models = (await d("config:getLocalCustomModels", [])).models;
  assert.equal(models[0].id, model);
  assert.equal(models[0].name, "qwen3-8b-4bit（本地）");
  assert.equal(models[0].url, "http://127.0.0.1:18725/v1");
  assert.equal(models[0].supportsToolCall, true);
  const product = await d("config:getProductConfiguration", []);
  assert.equal(product.models[0].id, "custom-local:" + model);
  assert.equal(product.models[0].name, "qwen3-8b-4bit（本地）");
});

test("text and validated media enter request; malformed attachments fail before model access", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    bodies = [];
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('event: delta\ndata: {"text":"ok"}\n\n');
      })(),
    };
  };
  const d = createDispatcher(f.options),
    s = await d("session:create", [{}]);
  await d("session:sendMessage", [
    s.sessionId,
    [
      { type: "text", text: "读取附件" },
      {
        type: "resource",
        resource: {
          uri: "file:///proof.txt",
          mimeType: "text/plain",
          text: "ATTACHMENT_PROOF_624",
        },
      },
    ],
  ]);
  assert(bodies[0].message.includes("ATTACHMENT_PROOF_624"));
  for (const block of [
    { type: "image", data: "test", mimeType: "image/png" },
    { type: "resource", resource: { uri: "file:///binary.bin", blob: "test" } },
  ])
    await assert.rejects(
      d("session:sendMessage", [s.sessionId, [{ type: "text", text: "测试" }, block]]),
    );
  assert.equal(bodies.length, 1);
  const image = { type: "image", mimeType: "image/png", data: Buffer.from([137,80,78,71,13,10,26,10]).toString("base64") };
  await d("session:sendMessage", [s.sessionId, [image]]);
  assert.deepEqual(bodies[1].media, [image]);
  assert.equal(bodies[1].message, "请分析附件。");
});

test("original flattened file URI attachments read workspace UTF-8 and reject escaping links", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    bodies = [];
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('event: delta\ndata: {"text":"ok"}\n\n');
      })(),
    };
  };
  const d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]);
  const filename = path.join(s.cwd, "中文 proof.txt");
  await fs.writeFile(filename, "FILE_URI_PROOF_739");
  const uri = require("node:url").pathToFileURL(filename).href;
  for (const type of ["resource", "resource_link"]) {
    const blocks = Object.freeze([
      Object.freeze({ type: "text", text: "读取文件" }),
      Object.freeze({ type, uri, name: "中文 proof.txt" }),
    ]);
    await d("session:sendMessage", [s.sessionId, blocks]);
    assert.equal(blocks[1].type, type);
    assert.equal(blocks[1].resource, undefined);
  }
  assert.equal(bodies.length, 2);
  assert(bodies.every((b) => b.message.includes("FILE_URI_PROOF_739")));
  const outside = path.join(f.dir, "private.txt");
  await fs.writeFile(outside, "PRIVATE_PROOF");
  const link = path.join(s.cwd, "escape.txt");
  await fs.symlink(outside, link);
  await assert.rejects(
    d("session:sendMessage", [
      s.sessionId,
      [{ type: "resource_link", uri: require("node:url").pathToFileURL(link).href }],
    ]),
    /私有目录/,
  );
  assert.equal(bodies.length, 2);
});

test("local uploaded text URLs resolve into model input and binary uploads are rejected", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    bodies = [];
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('event: delta\ndata: {"text":"ok"}\n\n');
      })(),
    };
  };
  const d = createDispatcher(f.options),
    s = await d("session:create", [{}]);
  const result = await d("file:upload", [
    {
      files: [
        {
          name: "中文附件.txt",
          type: "text/plain",
          data: new TextEncoder().encode("UPLOADED_TEXT_PROOF"),
        },
      ],
    },
  ]);
  assert.equal(result.success, true);
  assert(result.urls[0].startsWith("workbuddy-attachment://"));
  await d("session:sendMessage", [
    s.sessionId,
    [
      { type: "text", text: "读取附件" },
      { type: "resource_link", uri: result.urls[0], name: "中文附件.txt" },
    ],
  ]);
  assert(bodies[0].message.includes("UPLOADED_TEXT_PROOF"));
  await assert.rejects(
    d("file:upload", [{ files: [{ name: "binary", data: Uint8Array.of(0, 1) }] }]),
    /Binary/,
  );
});

test("original native selected absolute-path attachment reads outside workspace but rejects private and unselected paths", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    bodies = [];
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return base(url, options);
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('event: delta\ndata: {"text":"ok"}\n\n');
      })(),
    };
  };
  const d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    outside = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]);
  const filename = path.join(outside, "native.txt");
  await fs.writeFile(filename, "NATIVE_SELECTED_PROOF");
  const selected = (p) => ({
    type: "resource_link",
    uri: p,
    name: path.basename(p),
    _meta: { mentionType: "file", type: "file", filePath: p },
  });
  await d("session:sendMessage", [
    s.sessionId,
    [{ type: "text", text: "读取所选附件" }, selected(filename)],
  ]);
  assert(bodies[0].message.includes("NATIVE_SELECTED_PROOF"));
  await assert.rejects(
    d("session:sendMessage", [
      s.sessionId,
      [
        { type: "text", text: "读取附件" },
        { type: "resource_link", uri: filename },
      ],
    ]),
    /选择元数据/,
  );
  const privateFile = path.join(f.dir, "private.txt");
  await fs.writeFile(privateFile, "PRIVATE_PROOF");
  await assert.rejects(
    d("session:sendMessage", [
      s.sessionId,
      [{ type: "text", text: "读取附件" }, selected(privateFile)],
    ]),
    /私有目录/,
  );
  assert.equal(bodies.length, 1);
});

test("original file preview returns text or base64 from session workspace and rejects private files", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]);
  const file = path.join(cwd, "preview.txt");
  await fs.writeFile(file, "PREVIEW_中文_PROOF");
  assert.equal(
    await d("file:read", [file, undefined, { sessionId: s.sessionId }]),
    "PREVIEW_中文_PROOF",
  );
  assert.equal(
    Buffer.from(
      await d("file:read", [file, "base64", { sessionId: s.sessionId }]),
      "base64",
    ).toString(),
    "PREVIEW_中文_PROOF",
  );
  const privateFile = path.join(f.dir, "secret.txt");
  await fs.writeFile(privateFile, "PRIVATE");
  await assert.rejects(
    d("file:read", [privateFile, undefined, { sessionId: s.sessionId }]),
    /private files/,
  );
  await assert.rejects(
    d("file:read", [file, "unknown", { sessionId: s.sessionId }]),
    /Unsupported/,
  );
});

test("original file preview accepts original utf-8 encoding spelling", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    session = await d("session:create", [{ cwd }]);
  const filename = path.join(cwd, "encoding.txt");
  await fs.writeFile(filename, "原版预览编码");
  for (const encoding of ["utf-8", "utf8"])
    assert.equal(
      await d("file:read", [filename, encoding, { sessionId: session.sessionId }]),
      "原版预览编码",
    );
});

test("uploaded attachment preview survives dispatcher reload and rejects links into private data", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  const result = await d("file:upload", [
    { files: [{ name: "预览.txt", data: new TextEncoder().encode("上传预览证明") }] },
  ]);
  const reloaded = createDispatcher(f.options);
  assert.equal(await reloaded("file:read", [result.urls[0], "utf-8"]), "上传预览证明");
  assert.equal(
    Buffer.from(await reloaded("file:read", [result.urls[0], "base64"]), "base64").toString(),
    "上传预览证明",
  );
  const id = "11111111-1111-1111-1111-111111111111",
    privateFile = path.join(f.dir, "preview-secret.txt");
  await fs.writeFile(privateFile, "PRIVATE");
  await fs.symlink(privateFile, path.join(f.dir, "attachments", id));
  await assert.rejects(
    reloaded("file:read", ["workbuddy-attachment://" + id + "/secret.txt"]),
    /escapes storage/,
  );
  await assert.rejects(
    reloaded("file:read", ["workbuddy-attachment://invalid/preview.txt"]),
    /Invalid attachment/,
  );
});

test("original preview allowedDirs accepts directory or exact file grants without allowing sibling or private escapes", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    outside = await d("workspace:generateDefaultCwd", [{ root: await fs.mkdtemp(path.join(os.tmpdir(), "wb-preview-outside-")) }]);
  const file = path.join(outside, "allowed.txt"),
    sibling = path.join(outside, "sibling.txt");
  await fs.writeFile(file, "EXTERNAL_PREVIEW");
  await fs.writeFile(sibling, "SIBLING");
  assert.equal(
    await d("file:read", [file, "utf-8", { allowedDirs: [outside] }]),
    "EXTERNAL_PREVIEW",
  );
  assert.equal(await d("file:read", [file, "utf-8", { allowedDirs: [file] }]), "EXTERNAL_PREVIEW");
  await assert.rejects(d("file:read", [sibling, "utf-8", { allowedDirs: [file] }]), /outside/);
  await assert.rejects(
    d("file:read", [file, "utf-8", { allowedDirs: outside }]),
    /must be an array/,
  );
  const secret = path.join(f.dir, "secret-preview.txt"),
    link = path.join(outside, "link.txt");
  await fs.writeFile(secret, "PRIVATE");
  await fs.symlink(secret, link);
  await assert.rejects(
    d("file:read", [link, "utf-8", { allowedDirs: [outside] }]),
    /private files/,
  );
  await assert.rejects(
    d("file:read", [secret, "utf-8", { allowedDirs: [f.dir] }]),
    /private files/,
  );
});

test("original preview root directory grant retains path separator semantics", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    outside = await d("workspace:generateDefaultCwd", []),
    file = path.join(outside, "root-grant.txt");
  await fs.writeFile(file, "ROOT_GRANT");
  assert.equal(
    await d("file:read", [file, "utf-8", { allowedDirs: [path.parse(file).root] }]),
    "ROOT_GRANT",
  );
});

test("original preview supports files above 1 MB and original encodings with structured base64 size errors", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]);
  const file = path.join(cwd, "large-preview.txt"),
    content = "中".repeat(400000);
  await fs.writeFile(file, content);
  assert.equal(await d("file:read", [file, "utf-8", { sessionId: s.sessionId }]), content);
  assert.equal(
    Buffer.from(
      await d("file:read", [file, "base64", { sessionId: s.sessionId }]),
      "base64",
    ).toString(),
    content,
  );
  const encoded = path.join(cwd, "utf16.txt");
  await fs.writeFile(encoded, Buffer.from("编码兼容", "utf16le"));
  assert.equal(await d("file:read", [encoded, "utf16le", { sessionId: s.sessionId }]), "编码兼容");
  const huge = path.join(cwd, "oversize.bin"),
    handle = await fs.open(huge, "w");
  await handle.truncate(50 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    d("file:read", [huge, "base64", { sessionId: s.sessionId }]),
    (error) => error.code === "FILE_TOO_LARGE" && error.fileSize === 50 * 1024 * 1024 + 1,
  );
});

test(
  "macOS oversized image preview converts with native sips while preserving the input",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = await fixture(),
      d = createDispatcher(f.options),
      cwd = await d("workspace:generateDefaultCwd", []),
      s = await d("session:create", [{ cwd }]);
    const file = path.join(cwd, "large.png");
    await fs.writeFile(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const h = await fs.open(file, "r+");
    await h.truncate(50 * 1024 * 1024 + 1);
    await h.close();
    const result = Buffer.from(
      await d("file:read", [file, "base64", { sessionId: s.sessionId }]),
      "base64",
    );
    assert.equal(result[0], 255);
    assert.equal(result[1], 216);
    assert.equal((await fs.stat(file)).size, 50 * 1024 * 1024 + 1);
  },
);

test("original chunked preview returns exact byte ranges and end state using shared path authorization", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    file = path.join(cwd, "chunks.txt"),
    bytes = Buffer.from("中文_CHUNK_PROOF");
  await fs.writeFile(file, bytes);
  const options = { allowedDirs: [cwd] },
    parts = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const r = await d("file:readChunked", [{ filePath: file, offset, chunkSize: 4 }, options]);
    parts.push(Buffer.from(r.data, "base64"));
    assert.equal(r.totalSize, bytes.length);
    assert.equal(r.done, offset + 4 >= bytes.length);
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.deepEqual(
    await d("file:readChunked", [{ filePath: file, offset: bytes.length }, options]),
    { data: "", bytesRead: 0, totalSize: bytes.length, done: true },
  );
  await assert.rejects(
    d("file:readChunked", [{ filePath: file, offset: -1 }, options]),
    /Invalid chunk/,
  );
  const secret = path.join(f.dir, "chunk-secret.txt");
  await fs.writeFile(secret, "PRIVATE");
  await assert.rejects(
    d("file:readChunked", [{ filePath: secret }, { allowedDirs: [f.dir] }]),
    /private files/,
  );
});

test("original chunked IPC reads sessionId and allowedDirs from its single parameter object", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    file = path.join(cwd, "original-params.txt");
  await fs.writeFile(file, "ORIGINAL_PARAMS");
  const result = await d("file:readChunked", [
    { filePath: file, offset: 0, sessionId: s.sessionId },
  ]);
  assert.equal(Buffer.from(result.data, "base64").toString(), "ORIGINAL_PARAMS");
  assert.equal(result.done, true);
  const external = await d("workspace:generateDefaultCwd", []),
    other = path.join(external, "grant.txt");
  await fs.writeFile(other, "CALLER_GRANT");
  const granted = await d("file:readChunked", [
    { filePath: other, offset: 0, allowedDirs: [external] },
  ]);
  assert.equal(Buffer.from(granted.data, "base64").toString(), "CALLER_GRANT");
});

test("original file info returns stat contract for files and directories and rejects private paths", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    file = path.join(cwd, "info.txt");
  await fs.writeFile(file, "STAT_PROOF");
  const stat = await fs.stat(file),
    info = await d("file:getInfo", [file, { allowedDirs: [cwd] }]);
  assert.deepEqual(info, {
    size: stat.size,
    isDirectory: false,
    isFile: true,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
  });
  const directory = await d("file:getInfo", [cwd, { allowedDirs: [cwd] }]);
  assert.equal(directory.isDirectory, true);
  assert.equal(directory.isFile, false);
  const secret = path.join(f.dir, "private-stat.txt");
  await fs.writeFile(secret, "PRIVATE");
  await assert.rejects(d("file:getInfo", [secret, { allowedDirs: [f.dir] }]), /private files/);
});

test("original directory listing returns actual file and folder shapes and excludes private symlink targets", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []);
  await fs.writeFile(path.join(cwd, "file.txt"), "FILES");
  await fs.mkdir(path.join(cwd, "folder"));
  const secret = path.join(f.dir, "list-secret.txt");
  await fs.writeFile(secret, "PRIVATE");
  await fs.symlink(secret, path.join(cwd, "private-link"));
  const rows = await d("file:listDir", [cwd]);
  assert.deepEqual(
    rows.find((r) => r.name === "file.txt"),
    { name: "file.txt", type: "file", size: 5 },
  );
  assert.equal(rows.find((r) => r.name === "folder").type, "directory");
  assert(!rows.some((r) => r.name === "private-link"));
  assert.deepEqual(await d("file:listDir", [path.join(cwd, "missing")]), []);
  await assert.rejects(d("file:listDir", [f.dir]), /private files/);
});

test("original file search walks real nested names with case insensitive filtering and skips excluded directories", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []);
  for (const dir of ["Reports", "node_modules", ".hidden", "__pycache__"]) {
    await fs.mkdir(path.join(cwd, dir));
    await fs.writeFile(path.join(cwd, dir, "Proof.txt"), "DATA");
  }
  const result = await d("file:search", [{ cwd, search: "PROOF", resultNum: 10 }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    path: path.join(cwd, "Reports", "Proof.txt"),
    relativePath: path.join("Reports", "Proof.txt"),
    fileName: "Proof.txt",
    folderName: undefined,
    type: "file",
  });
  assert.equal((await d("file:search", [{ cwd, search: "", resultNum: 1 }])).length, 1);
  assert.deepEqual(await d("file:search", [{ cwd, resultNum: 0 }]), []);
  await assert.rejects(d("file:search", [{ cwd: f.dir, search: "" }]), /private files/);
});

test("original file existence reflects disk and accepts file URIs and persisted upload handles", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    file = path.join(cwd, "存在.txt");
  await fs.writeFile(file, "EXISTS");
  assert.equal(await d("file:exists", [file]), true);
  assert.equal(await d("file:exists", [require("node:url").pathToFileURL(file).href]), true);
  assert.equal(await d("file:exists", [path.join(cwd, "missing")]), false);
  assert.equal(await d("file:exists", [null]), false);
  const upload = await d("file:upload", [
    { files: [{ name: "exists.txt", data: new TextEncoder().encode("UPLOAD") }] },
  ]);
  assert.equal(await createDispatcher(f.options)("file:exists", [upload.urls[0]]), true);
  assert.equal(await d("file:exists", ["workbuddy-attachment://invalid/file"]), false);
});

test("original editor file write persists text with selected encoding and rejects private paths before changes", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    file = path.join(cwd, "editor.txt");
  await d("file:write", [file, "编辑保存", "utf16le", { sessionId: s.sessionId }]);
  assert.equal((await fs.readFile(file)).toString("utf16le"), "编辑保存");
  await d("file:write", [file, "更新内容", "utf-8", { sessionId: s.sessionId }]);
  assert.equal(await fs.readFile(file, "utf8"), "更新内容");
  await assert.rejects(
    d("file:write", [file, "INVALID", "invalid", { sessionId: s.sessionId }]),
    /Unsupported/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "更新内容");
  const secret = path.join(f.dir, "editor-secret.txt");
  await fs.writeFile(secret, "PRIVATE");
  await assert.rejects(
    d("file:write", [secret, "CHANGED", "utf-8", { allowedDirs: [f.dir] }]),
    /private files/,
  );
  assert.equal(await fs.readFile(secret, "utf8"), "PRIVATE");
  assert(!(await fs.readdir(cwd)).some((name) => name.startsWith(".wb-local-write-")));
});

test("original batch editor write uses path data encoding entries and shared session options", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]);
  const a = path.join(cwd, "batch-a.txt"),
    b = path.join(cwd, "batch-b.txt");
  await d("file:writeBatch", [
    [
      { path: a, data: "批量A" },
      { path: b, data: "批量B", encoding: "utf16le" },
    ],
    { sessionId: s.sessionId },
  ]);
  assert.equal(await fs.readFile(a, "utf8"), "批量A");
  assert.equal((await fs.readFile(b)).toString("utf16le"), "批量B");
  await d("file:writeBatch", [[], { sessionId: s.sessionId }]);
  await assert.rejects(d("file:writeBatch", [{}]), /requires an array/);
  const secret = path.join(f.dir, "batch-secret.txt");
  await fs.writeFile(secret, "PRIVATE");
  await assert.rejects(
    d("file:writeBatch", [[{ path: secret, data: "CHANGED" }], { allowedDirs: [f.dir] }]),
    /private files/,
  );
  assert.equal(await fs.readFile(secret, "utf8"), "PRIVATE");
});

test("original editor write creates nested parent directories within its session workspace", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    file = path.join(cwd, "new", "nested", "editor.txt");
  await d("file:write", [file, "NESTED_SAVE", "utf-8", { sessionId: s.sessionId }]);
  assert.equal(await fs.readFile(file, "utf8"), "NESTED_SAVE");
  const secret = path.join(f.dir, "new-private", "editor.txt");
  await assert.rejects(
    d("file:write", [secret, "PRIVATE_WRITE", "utf-8", { allowedDirs: [f.dir] }]),
    /private files/,
  );
  assert.equal(await d("file:exists", [secret]), false);
});

test("editor save preserves existing access mode and rejects directory replacement", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    file = path.join(cwd, "permissions.txt");
  await fs.writeFile(file, "OLD");
  await fs.chmod(file, 0o640);
  await d("file:write", [file, "NEW", "utf-8", { sessionId: s.sessionId }]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(file, "utf8"), "NEW");
  const directory = path.join(cwd, "directory");
  await fs.mkdir(directory);
  await assert.rejects(
    d("file:write", [directory, "BAD", "utf-8", { sessionId: s.sessionId }]),
    /regular file/,
  );
  assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test("editor can save to explicitly granted nonexistent directory without authorizing private destinations", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    outside = await d("workspace:generateDefaultCwd", []),
    directory = path.join(outside, "new-granted"),
    file = path.join(directory, "nested", "file.txt");
  await d("file:write", [file, "NEW_GRANT", "utf-8", { allowedDirs: [directory] }]);
  assert.equal(await fs.readFile(file, "utf8"), "NEW_GRANT");
  const secretDir = path.join(f.dir, "new-private-grant"),
    secret = path.join(secretDir, "secret.txt");
  await assert.rejects(
    d("file:write", [secret, "PRIVATE", "utf-8", { allowedDirs: [secretDir] }]),
    /private files/,
  );
  assert.equal(await d("file:exists", [secret]), false);
});

test("nonexistent editor destination rejects dangling directory links before creating targets", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    link = path.join(cwd, "dangling"),
    target = path.join(f.dir, "not-created");
  await fs.symlink(target, link);
  await assert.rejects(
    d("file:write", [path.join(link, "file.txt"), "BAD", "utf-8", { allowedDirs: [cwd] }]),
    /Unresolved symbolic link/,
  );
  assert.equal(await d("file:exists", [target]), false);
});

test("original directory creation defaults recursive and honors false without creating private targets", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    dir = path.join(cwd, "new", "folder");
  await d("file:makeDir", [dir, undefined, { sessionId: s.sessionId }]);
  assert.equal((await fs.stat(dir)).isDirectory(), true);
  const single = path.join(cwd, "single");
  await d("file:makeDir", [single, false, { sessionId: s.sessionId }]);
  assert.equal((await fs.stat(single)).isDirectory(), true);
  await assert.rejects(
    d("file:makeDir", [path.join(cwd, "missing", "nested"), false, { sessionId: s.sessionId }]),
    (error) => error.code === "ENOENT",
  );
  const secret = path.join(f.dir, "new-private-dir");
  await assert.rejects(
    d("file:makeDir", [secret, true, { allowedDirs: [f.dir] }]),
    /private files/,
  );
  assert.equal(await d("file:exists", [secret]), false);
});

test("file rename moves actual file and directory with original return shape and validates both paths", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    source = path.join(cwd, "old.txt"),
    destination = path.join(cwd, "new.txt"),
    options = { sessionId: s.sessionId };
  await fs.writeFile(source, "RENAME_PROOF");
  assert.equal(await d("file:rename", [source, destination, options]), undefined);
  assert.equal(await d("file:exists", [source]), false);
  assert.equal(await fs.readFile(destination, "utf8"), "RENAME_PROOF");
  const folder = path.join(cwd, "folder"),
    renamed = path.join(cwd, "renamed-folder");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "child.txt"), "CHILD");
  await d("file:rename", [folder, renamed, options]);
  assert.equal(await fs.readFile(path.join(renamed, "child.txt"), "utf8"), "CHILD");
  await assert.rejects(
    d("file:rename", [
      destination,
      path.join(f.dir, "private-target.txt"),
      { allowedDirs: [cwd, f.dir] },
    ]),
    /private files/,
  );
  assert.equal(await fs.readFile(destination, "utf8"), "RENAME_PROOF");
});

test("original rename moves symbolic link entry and replaces destination link without moving either target", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    options = { sessionId: s.sessionId };
  const target = path.join(cwd, "target.txt"),
    link = path.join(cwd, "old-link"),
    next = path.join(cwd, "new-link");
  await fs.writeFile(target, "TARGET");
  await fs.symlink(target, link);
  await d("file:rename", [link, next, options]);
  assert.equal((await fs.lstat(next)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(next), target);
  assert.equal(await fs.readFile(target, "utf8"), "TARGET");
  const replacement = path.join(cwd, "replacement.txt"),
    destination = path.join(cwd, "destination-link"),
    other = path.join(cwd, "other-target.txt");
  await fs.writeFile(replacement, "REPLACEMENT");
  await fs.writeFile(other, "OTHER_TARGET");
  await fs.symlink(other, destination);
  await d("file:rename", [replacement, destination, options]);
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(destination, "utf8"), "REPLACEMENT");
  assert.equal(await fs.readFile(other, "utf8"), "OTHER_TARGET");
});

test("original desktop file operations allow home paths without session options but still reject private storage", async () => {
  const f = await fixture(),
    base = createDispatcher(f.options),
    home = await base("workspace:generateDefaultCwd", []),
    d = createDispatcher({ ...f.options, homeDir: home }),
    file = path.join(home, "home-preview.txt");
  await fs.writeFile(file, "HOME_PREVIEW");
  assert.equal(await d("file:read", [file, "utf-8"]), "HOME_PREVIEW");
  assert.equal((await d("file:getInfo", [file])).isFile, true);
  const dir = path.join(home, "new", "nested");
  await d("file:makeDir", [dir]);
  const created = path.join(dir, "save.txt");
  await d("file:write", [created, "HOME_SAVE"]);
  const renamed = path.join(dir, "renamed.txt");
  await d("file:rename", [created, renamed]);
  assert.equal(await fs.readFile(renamed, "utf8"), "HOME_SAVE");
  const privateDispatcher = createDispatcher({ ...f.options, homeDir: path.dirname(f.dir) }),
    secret = path.join(f.dir, "home-secret.txt");
  await fs.writeFile(secret, "PRIVATE");
  await assert.rejects(privateDispatcher("file:read", [secret]), /private files/);
});

test("original editor save replaces selected symbolic link without modifying its target", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    s = await d("session:create", [{ cwd }]),
    target = path.join(cwd, "write-target.txt"),
    link = path.join(cwd, "write-link.txt");
  await fs.writeFile(target, "TARGET_UNCHANGED");
  await fs.symlink(target, link);
  await d("file:write", [link, "EDITOR_SAVE", "utf-8", { sessionId: s.sessionId }]);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(link, "utf8"), "EDITOR_SAVE");
  assert.equal(await fs.readFile(target, "utf8"), "TARGET_UNCHANGED");
});

test("original skill URL preparation streams Markdown into SKILL.md and rejects non HTTPS before fetching", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let requests = 0;
  f.options.fetchImpl = async (url, options) => {
    if (url.startsWith("https://")) {
      requests++;
      return new Response("---\nname: downloaded-skill\n---\nREAL_DOWNLOAD", { status: 200 });
    }
    return base(url, options);
  };
  const d = createDispatcher(f.options),
    result = await d("skill:prepareFromUrl", [
      { skillName: "downloaded-skill", downloadUrl: "https://example.test/skill.md" },
    ]);
  assert.equal(result.success, true);
  assert.equal(result.skillName, "downloaded-skill");
  assert(
    (await fs.readFile(path.join(result.downloadedFilePath, "SKILL.md"), "utf8")).includes(
      "REAL_DOWNLOAD",
    ),
  );
  assert.equal(
    (
      await d("skill:prepareFromUrl", [
        { skillName: "x", downloadUrl: "http://example.test/skill.zip" },
      ])
    ).errorKey,
    "invalidDownloadUrl",
  );
  assert.equal(requests, 1);
  assert.equal(
    (await d("skill:prepareFromUrl", [{ downloadUrl: "https://example.test/skill.zip" }])).errorKey,
    "invalidSkillId",
  );
});

test("skill preparation rejects oversized length streamed overflow and insecure final redirect and cleans failed downloads", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let mode = "length",
    consumed = 0;
  f.options.fetchImpl = async (url, options) => {
    if (!url.startsWith("https://")) return base(url, options);
    return {
      ok: true,
      url: mode === "redirect" ? "http://example.test/insecure.zip" : url,
      headers: new Headers(
        mode === "length" ? { "content-length": String(50 * 1024 * 1024 + 1) } : {},
      ),
      body: (async function* () {
        consumed++;
        const chunk = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < 51; i++) yield chunk;
      })(),
    };
  };
  const d = createDispatcher(f.options),
    params = { skillName: "download", downloadUrl: "https://example.test/download.zip" };
  const before = new Set(
    (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("wb-local-skill-download-")),
  );
  assert.equal((await d("skill:prepareFromUrl", [params])).errorKey, "downloadTooLarge");
  assert.equal(consumed, 0);
  mode = "stream";
  assert.equal((await d("skill:prepareFromUrl", [params])).errorKey, "downloadTooLarge");
  assert.equal(consumed, 1);
  mode = "redirect";
  assert.equal((await d("skill:prepareFromUrl", [params])).errorKey, "invalidDownloadUrl");
  assert.equal(consumed, 1);
  const after = (await fs.readdir(os.tmpdir())).filter(
    (n) => n.startsWith("wb-local-skill-download-") && !before.has(n),
  );
  assert.deepEqual(after, []);
  assert.equal(
    (
      await d("skill:prepareFromUrl", [
        { skillName: 123, downloadUrl: "https://example.test/a.zip" },
      ])
    ).errorKey,
    "invalidSkillId",
  );
  assert.equal(
    (await d("skill:prepareFromUrl", [{ skillName: "x", downloadUrl: 123 }])).errorKey,
    "invalidDownloadUrl",
  );
});

test("URL installation imports downloaded skill using real adapter ID and does not fake security scanning", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://")
      ? new Response(
          "---\nname: url-installed-skill\ndescription: URL proof\n---\nUse URL_INSTRUCTION",
          { status: 200 },
        )
      : base(url, options);
  const d = createDispatcher(f.options),
    params = { skillName: "url-installed-skill", downloadUrl: "https://example.test/SKILL.md" };
  const blocked = await d("skill:installFromUrl", [params]);
  assert.equal(blocked.success, false);
  assert.equal(blocked.errorKey, "security_check_blocked");
  const result = await d("skill:installFromUrl", [{ ...params, securityCheck: false }]);
  assert.equal(result.success, true);
  assert.equal(result.skillName, "url-installed-skill");
  assert.deepEqual(result.importedSkillIds, [result.activatedSkillId]);
  const list = await d("skill:list", [{}]);
  assert(list.results.some((skill) => skill.id === result.activatedSkillId));
  assert((await fs.readFile(result.installedFilePath, "utf8")).includes("URL_INSTRUCTION"));
});

test("standalone download preparation never accesses the backend and preserves HTTP failure detail", async () => {
  const f = await fixture();
  let calls = 0;
  const d = createDispatcher({
    ...f.options,
    fetchImpl: async (url) => {
      assert(url.startsWith("https://"));
      calls++;
      return new Response("missing", { status: 404 });
    },
  });
  const r = await d("skill:prepareFromUrl", [
    { skillName: "missing", downloadUrl: "https://example.test/missing.zip" },
  ]);
  assert.equal(r.success, false);
  assert.equal(r.errorKey, "installFromUrlFailed");
  assert.match(r.errorMessage, /HTTP 404/);
  assert.equal(calls, 1);
});
test("URL duplicate installation preserves existing package and explicit overwrite keeps the selected ID", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let text = "FIRST";
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://")
      ? new Response("---\nname: url-duplicate-proof\n---\n" + text)
      : base(url, options);
  const d = createDispatcher(f.options),
    params = {
      skillName: "url-duplicate-proof",
      downloadUrl: "https://example.test/SKILL.md",
      securityCheck: false,
    };
  const first = await d("skill:installFromUrl", [params]);
  assert.equal(first.success, true);
  text = "SECOND";
  const duplicate = await d("skill:installFromUrl", [params]);
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.errorKey, "duplicateSkillName");
  assert((await fs.readFile(first.installedFilePath, "utf8")).includes("FIRST"));
  const replaced = await d("skill:installFromUrl", [{ ...params, overwrite: true }]);
  assert.equal(replaced.success, true);
  assert.equal(replaced.activatedSkillId, first.activatedSkillId);
  assert((await fs.readFile(replaced.installedFilePath, "utf8")).includes("SECOND"));
});

test("URL-installed skill activation ID resolves into the actual chat selected skill IDs", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let chatBody;
  f.options.fetchImpl = async (url, options) => {
    if (url.startsWith("https://"))
      return new Response("---\nname: url-chat-proof\n---\nFollow URL_CHAT_INSTRUCTION");
    if (url.endsWith("/chat")) {
      chatBody = JSON.parse(options.body);
      return {
        ok: true,
        body: (async function* () {
          yield new TextEncoder().encode('event: delta\ndata: {"text":"URL_CHAT_REPLY"}\n\n');
        })(),
      };
    }
    return base(url, options);
  };
  const d = createDispatcher(f.options),
    installed = await d("skill:installFromUrl", [
      {
        skillName: "url-chat-proof",
        downloadUrl: "https://example.test/SKILL.md",
        securityCheck: false,
      },
    ]);
  assert.equal(installed.success, true);
  const session = await d("session:create", [
    { config: { skillIds: [installed.activatedSkillId] } },
  ]);
  await d("session:sendMessage", [
    session.sessionId,
    [{ type: "text", text: "Use installed skill" }],
  ]);
  assert.deepEqual(chatBody.skillIds, [installed.activatedSkillId.replace(/^local-skill:/, "")]);
  assert.equal(
    (await fs.readFile(installed.installedFilePath, "utf8")).includes("URL_CHAT_INSTRUCTION"),
    true,
  );
});

test("expert marker cleanup RPC refreshes stored expert metadata without changing its session binding", async () => {
  const f = await fixture(),
    dataDir = path.join(f.dir, "data"),
    root = path.join(
      f.dir,
      "expert-config",
      "plugins",
      "marketplaces",
      "my-experts",
      "plugins",
      "marker-proof",
    );
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({
      name: "marker-proof",
      agentName: "marker-proof",
      expertType: "agent",
      displayName: "Marker proof",
    }),
  );
  await fs.writeFile(path.join(root, "agents", "marker-proof.md"), "EXPERT_INSTRUCTION");
  await fs.writeFile(path.join(root, ".created-by-session"), "CREATOR_SESSION");
  const d = createDispatcher({ ...f.options, dataDir }),
    id = "custom-expert:marker-proof";
  const before = await d("expert:scanCustomExperts", []);
  assert.equal(before.experts.find((e) => e.id === id).createdBySession, "CREATOR_SESSION");
  const session = await d("session:create", [{ config: { expertId: id } }]);
  assert.equal(await d("expert:clearCustomExpertSessionMarker", [{ expertId: id }]), undefined);
  const after = await d("expert:getExperts", []);
  assert.equal(after.experts.find((e) => e.id === id).createdBySession, null);
  assert.equal(f.entities.sessions.find((s) => s.id === session.sessionId).expertId, id);
  assert.equal(
    await fs.readFile(path.join(root, "agents", "marker-proof.md"), "utf8"),
    "EXPERT_INSTRUCTION",
  );
});

test("expert share hash-only precheck computes actual streaming MD5 without claiming a security scan", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    cwd = await d("workspace:generateDefaultCwd", []),
    file = path.join(cwd, "expert.zip"),
    bytes = Buffer.from("EXPERT_PACKAGE_HASH_PROOF");
  await fs.writeFile(file, bytes);
  const result = await d("expert:preCheckShare", [{ zipPath: file, computeMd5Only: true }]);
  assert.deepEqual(result, {
    success: true,
    md5: require("node:crypto").createHash("md5").update(bytes).digest("hex"),
    selectedPath: file,
  });
  assert.equal(
    (await d("expert:preCheckShare", [{ zipPath: file }])).errorKey,
    "security_unavailable",
  );
  assert.equal((await d("expert:preCheckShare", [{}])).errorKey, "invalid_package");
  assert.equal(
    (
      await d("expert:preCheckShare", [
        { zipPath: path.join(cwd, "missing.zip"), computeMd5Only: true },
      ])
    ).errorKey,
    "invalid_package",
  );
  const secret = path.join(f.dir, "share-private.zip");
  await fs.writeFile(secret, "PRIVATE");
  const blocked = await d("expert:preCheckShare", [{ zipPath: secret, computeMd5Only: true }]);
  assert.equal(blocked.success, false);
  assert.equal(blocked.errorKey, "invalid_package");
});

test("expert export ZIP feeds share hash precheck with exact actual archive bytes", async () => {
  const f = await fixture(),
    dataDir = path.join(f.dir, "data"),
    root = path.join(
      f.dir,
      "expert-config",
      "plugins",
      "marketplaces",
      "my-experts",
      "plugins",
      "share-proof",
    );
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({
      name: "share-proof",
      agentName: "share-proof",
      expertType: "agent",
      displayName: "Share proof",
    }),
  );
  await fs.writeFile(path.join(root, "agents", "share-proof.md"), "SHARE_PACKAGE_INSTRUCTION");
  await fs.writeFile(path.join(root, "reference.bin"), Buffer.from([0, 255, 2, 3]));
  const d = createDispatcher({ ...f.options, dataDir }),
    exported = await d("expert:exportZip", [{ expertId: "custom-expert:share-proof" }]);
  assert.equal(exported.success, true);
  const result = await d("expert:preCheckShare", [
    { zipPath: exported.zipPath, computeMd5Only: true },
  ]);
  assert.equal(result.success, true);
  const archive = await fs.readFile(exported.zipPath);
  assert.equal(result.md5, require("node:crypto").createHash("md5").update(archive).digest("hex"));
  assert.equal(result.selectedPath, exported.zipPath);
  const files = await require("./expert-zip.cjs").readExpertZip(exported.zipPath);
  assert.equal(files.get("agents/share-proof.md").toString(), "SHARE_PACKAGE_INSTRUCTION");
  assert.deepEqual(files.get("reference.bin"), Buffer.from([0, 255, 2, 3]));
  assert.equal(
    (await d("expert:preCheckShare", [{ zipPath: exported.zipPath }])).errorKey,
    "security_unavailable",
  );
});

test("expert URL import uses original failure keys and rejects unavailable scanning and malformed packages", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl;
  let downloads = 0;
  f.options.fetchImpl = async (url, options) => {
    if (url.startsWith("https://")) {
      downloads++;
      return new Response("NOT_A_ZIP");
    }
    return base(url, options);
  };
  const d = createDispatcher(f.options);
  assert.equal((await d("expert:importFromUrl", [{}])).errorKey, "invalid_download_url");
  assert.equal(
    (
      await d("expert:importFromUrl", [
        { downloadUrl: "https://example.test/expert.zip", securityCheck: true },
      ])
    ).errorKey,
    "security_check_blocked",
  );
  assert.equal(downloads, 0);
  assert.equal(
    (
      await d("expert:importFromUrl", [
        { downloadUrl: "https://example.test/expert.zip", securityCheck: false },
      ])
    ).errorKey,
    "invalid_package",
  );
  assert.equal(downloads, 1);
});

test("expert URL import installs a real ZIP rejects duplicate and archives previous package on overwrite", async () => {
  const downloadDirs = new Set(
    (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("wb-local-skill-download-")),
  );
  const f = await fixture(),
    base = f.options.fetchImpl,
    { createExpertZip } = require("./expert-zip.cjs");
  let content = "URL_EXPERT_FIRST";
  const packageBytes = () =>
    createExpertZip(
      new Map([
        [
          ".codebuddy-plugin/plugin.json",
          Buffer.from(
            JSON.stringify({
              name: "url-expert-proof",
              agentName: "url-expert-proof",
              expertType: "agent",
              displayName: "URL Expert",
            }),
          ),
        ],
        ["agents/url-expert-proof.md", Buffer.from(content)],
        ["proof.bin", Buffer.from([0, 255, 1])],
      ]),
    );
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://") ? new Response(packageBytes()) : base(url, options);
  const d = createDispatcher({ ...f.options, dataDir: path.join(f.dir, "data") }),
    params = { downloadUrl: "https://example.test/expert.zip", securityCheck: false };
  const installed = await d("expert:importFromUrl", [params]);
  assert.equal(installed.success, true);
  assert.equal(installed.expertId, "custom-expert:url-expert-proof");
  assert.equal(
    await fs.readFile(path.join(installed.localPath, "agents/url-expert-proof.md"), "utf8"),
    content,
  );
  const list = await d("expert:getExperts", []);
  assert(list.experts.some((e) => e.id === installed.expertId));
  content = "URL_EXPERT_SECOND";
  const duplicate = await d("expert:importFromUrl", [params]);
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.errorKey, "duplicate_expert");
  assert.equal(
    await fs.readFile(path.join(installed.localPath, "agents/url-expert-proof.md"), "utf8"),
    "URL_EXPERT_FIRST",
  );
  const replaced = await d("expert:importFromUrl", [{ ...params, overwrite: true }]);
  assert.equal(replaced.success, true);
  assert.equal(replaced.expertId, installed.expertId);
  assert.equal(
    await fs.readFile(path.join(replaced.localPath, "agents/url-expert-proof.md"), "utf8"),
    content,
  );
  assert.deepEqual(
    await fs.readFile(path.join(replaced.localPath, "proof.bin")),
    Buffer.from([0, 255, 1]),
  );
  assert(
    (await fs.readdir(path.join(f.dir, "expert-config", "expert-trash"))).some((name) =>
      name.startsWith("url-expert-proof-"),
    ),
  );
  assert.deepEqual(
    (await fs.readdir(os.tmpdir())).filter(
      (n) => n.startsWith("wb-local-skill-download-") && !downloadDirs.has(n),
    ),
    [],
  );
});

test("expert URL preview reads real ZIP metadata and packaged avatar without installing an expert", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    { createExpertZip } = require("./expert-zip.cjs"),
    avatar = Buffer.from([137, 80, 78, 71]);
  const bytes = createExpertZip(
    new Map([
      [
        ".codebuddy-plugin/plugin.json",
        Buffer.from(
          JSON.stringify({
            name: "preview-proof",
            agentName: "preview-proof",
            expertType: "agent",
            displayName: { zh: "预览专家" },
            description: "ZIP_DESCRIPTION",
            avatar: "avatar.png",
            onboarding: { triggerPrompt: "开始任务" },
          }),
        ),
      ],
      ["agents/preview-proof.md", Buffer.from("PREVIEW_INSTRUCTIONS")],
      ["avatar.png", avatar],
    ]),
  );
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://") ? new Response(bytes) : base(url, options);
  const d = createDispatcher({ ...f.options, dataDir: path.join(f.dir, "data") }),
    result = await d("expert:previewFromUrl", [{ downloadUrl: "https://example.test/expert.zip" }]);
  assert.equal(result.success, true);
  assert.equal(result.metadata.expertId, "preview-proof");
  assert.deepEqual(result.metadata.displayName, { zh: "预览专家" });
  assert.equal(result.metadata.description, "ZIP_DESCRIPTION");
  assert.equal(result.metadata.avatar, "data:image/png;base64," + avatar.toString("base64"));
  assert.deepEqual(result.metadata.triggerPrompts, ["开始任务"]);
  assert(!f.entities.experts.some((e) => e.id === "custom-expert:preview-proof"));
  assert.equal(
    await d("file:exists", [
      path.join(
        f.dir,
        "expert-config",
        "plugins",
        "marketplaces",
        "my-experts",
        "plugins",
        "preview-proof",
      ),
    ]),
    false,
  );
});

test("expert ZIP preview normalizes legacy localized lists and malformed members with original trigger precedence", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    { createExpertZip } = require("./expert-zip.cjs"),
    manifest = {
      name: "localized-preview",
      agentName: "localized-preview",
      tags: { zh: ["标签一", "标签二"], en: ["Tag one"] },
      quickPrompts: { zh: ["中文提示"], en: ["English prompt"] },
      triggerPrompts: { zh: ["开始"], en: ["Start"] },
      members: "malformed",
      onboarding: { triggerPrompt: "IGNORED" },
    };
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://")
      ? new Response(
          createExpertZip(
            new Map([
              [".codebuddy-plugin/plugin.json", Buffer.from(JSON.stringify(manifest))],
              ["agents/localized-preview.md", Buffer.from("PROMPT")],
            ]),
          ),
        )
      : base(url, options);
  const d = createDispatcher(f.options),
    r = await d("expert:previewFromUrl", [{ downloadUrl: "https://example.test/package.zip" }]);
  assert.equal(r.success, true);
  assert.deepEqual(r.metadata.tags, [{ zh: "标签一", en: "Tag one" }, { zh: "标签二" }]);
  assert.deepEqual(r.metadata.quickPrompts, [{ zh: "中文提示", en: "English prompt" }]);
  assert.deepEqual(r.metadata.triggerPrompts, [{ zh: "开始", en: "Start" }]);
  assert.deepEqual(r.metadata.members, []);
});

test("team ZIP preview uses installed-member identity precedence without installing", async () => {
  const f = await fixture(), base = f.options.fetchImpl;
  const { createExpertZip } = require("./expert-zip.cjs");
  const members = [
    { agent_name: " lead ", agent: "ignored", id: "old", name: "主编" },
    { agent: "writer", id: "ignored", name: "撰稿" },
    { id: 7, name: "校对" },
  ];
  const manifest = { name: "preview-team", expertType: "team",
    teamInfo: { leadAgent: "lead" }, members };
  const bytes = createExpertZip(new Map([
    [".codebuddy-plugin/plugin.json", Buffer.from(JSON.stringify(manifest))],
    ["agents/lead.md", Buffer.from("Coordinate editing.")],
  ]));
  f.options.fetchImpl = async (url, options) => url.startsWith("https://example.test/")
    ? new Response(bytes) : base(url, options);
  const d = createDispatcher(f.options);
  const result = await d("expert:previewFromUrl", [{ downloadUrl: "https://example.test/team.zip" }]);
  assert.equal(result.success, true);
  assert.deepEqual(result.metadata.members.map(member => member.id), ["lead", "writer", "7"]);
  assert.deepEqual(result.metadata.members.map(member => member.name), ["主编", "撰稿", "校对"]);
  assert.equal(manifest.members[0].id, "old");
  assert(!f.entities.experts.some(expert => expert.id === "custom-expert:preview-team"));
});

test("original expert HTTP download is accepted while skill preparation still rejects HTTP", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    { createExpertZip } = require("./expert-zip.cjs");
  let downloads = 0;
  const bytes = createExpertZip(
    new Map([
      [
        ".codebuddy-plugin/plugin.json",
        Buffer.from(JSON.stringify({ name: "http-expert-proof", agentName: "http-expert-proof" })),
      ],
      ["agents/http-expert-proof.md", Buffer.from("HTTP_PROOF")],
    ]),
  );
  f.options.fetchImpl = async (url, options) => {
    if (url.startsWith("http://example.test/")) {
      downloads++;
      return new Response(bytes);
    }
    return base(url, options);
  };
  const d = createDispatcher({ ...f.options, dataDir: path.join(f.dir, "data") });
  const result = await d("expert:previewFromUrl", [
    { downloadUrl: "http://example.test/package.zip" },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.metadata.expertId, "http-expert-proof");
  assert.equal(downloads, 1);
  const rejected = await d("skill:prepareFromUrl", [
    { skillName: "test", downloadUrl: "http://example.test/package.zip" },
  ]);
  assert.equal(rejected.errorKey, "invalidDownloadUrl");
  assert.equal(downloads, 1);
});

test("expert preview root-prefixed avatar resolves valid PNG bytes and preserves URL case", async () => {
  const f = await fixture(),
    base = f.options.fetchImpl,
    { createExpertZip } = require("./expert-zip.cjs"),
    image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
  let avatar = "/avatar.png";
  f.options.fetchImpl = async (url, options) =>
    url.startsWith("https://")
      ? new Response(
          createExpertZip(
            new Map([
              [
                ".codebuddy-plugin/plugin.json",
                Buffer.from(
                  JSON.stringify({
                    name: "root-avatar-proof",
                    agentName: "root-avatar-proof",
                    avatar,
                  }),
                ),
              ],
              ["agents/root-avatar-proof.md", Buffer.from("PROMPT")],
              ["avatar.png", image],
            ]),
          ),
        )
      : base(url, options);
  const d = createDispatcher(f.options),
    params = { downloadUrl: "https://example.test/expert.zip" };
  const r = await d("expert:previewFromUrl", [params]);
  assert.equal(r.success, true);
  assert.equal(r.metadata.avatar, "data:image/png;base64," + image.toString("base64"));
  avatar = "HTTPS://example.test/avatar.png";
  assert.equal((await d("expert:previewFromUrl", [params])).metadata.avatar, avatar);
  avatar = "/missing.png";
  assert.equal((await d("expert:previewFromUrl", [params])).metadata.avatar, undefined);
});

test("original local MCP configuration editor reads stored env and credentials while list remains the public adapter", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await fs.writeFile(
    path.join(f.dir, "connectors.json"),
    JSON.stringify([
      {
        id: "stdio-proof",
        name: "Local stdio",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TEST_TOKEN: "editor-fixture-token" },
      },
      {
        id: "http-proof",
        name: "Local HTTP",
        transport: "http",
        url: "https://example.test/mcp",
        apiKey: "editor-fixture-key",
      },
    ]),
  );
  const config = JSON.parse((await d("mcp:getConfigContent", [])).content);
  assert.deepEqual(config.mcpServers["Local stdio"].env, { TEST_TOKEN: "editor-fixture-token" });
  assert.equal(config.mcpServers["Local HTTP"].apiKey, "editor-fixture-key");
  assert(!JSON.stringify(await d("mcp:list", [])).includes("editor-fixture-key"));
});

test("original MCP toggle persists disabled flag and exposes matching enabled state", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options);
  await d("mcp:saveConfigContent", [
    {
      content: JSON.stringify({
        mcpServers: { proof: { url: "https://example.test/mcp", disabled: true } },
      }),
    },
  ]);
  assert.equal((await d("mcp:list", []))[0].enabled, false);
  assert.equal(await d("mcp:toggle", [{ serverName: "proof", enabled: true }]), undefined);
  assert.equal((await d("mcp:list", []))[0].enabled, true);
  await d("mcp:toggle", [{ serverName: "proof", enabled: false }]);
  assert.equal(f.entities.connectors[0].disabled, true);
  await d("mcp:toggleTool", [{ serverName: "proof", toolName: "read_proof", enabled: false }]);
  assert.deepEqual(f.entities.connectors[0].disabledTools, ["read_proof"]);
  await d("mcp:toggleTool", [{ serverName: "proof", toolName: "read_proof", enabled: true }]);
  assert.deepEqual(f.entities.connectors[0].disabledTools, []);
  assert.equal(f.entities.connectors[0].disabled, true);
});

test("MCP open config delegates only the actual user JSON document to the desktop opener", async () => {
  const f = await fixture(),
    opened = [],
    d = createDispatcher({
      ...f.options,
      openPath: async (filename) => {
        opened.push(filename);
        return "";
      },
    });
  await d("mcp:saveConfigContent", [
    { content: JSON.stringify({ mcpServers: { proof: { url: "https://example.test/mcp" } } }) },
  ]);
  const document = await d("mcp:getConfigContent", []);
  assert.equal(document.filePath, path.join(f.dir, "mcp.json"));
  assert.deepEqual(
    JSON.parse(await fs.readFile(document.filePath, "utf8")),
    JSON.parse(document.content),
  );
  assert.equal(await d("mcp:openConfig", []), undefined);
  assert.deepEqual(opened, [await fs.realpath(document.filePath)]);
  const base = f.options.fetchImpl,
    bad = createDispatcher({
      ...f.options,
      openPath: async (filename) => opened.push(filename),
      fetchImpl: async (url, options) =>
        url.endsWith("/connectors/config")
          ? {
              ok: true,
              json: async () => ({ filePath: path.join(f.dir, "wrong.json"), content: "{}" }),
            }
          : base(url, options),
    });
  await assert.rejects(bad("mcp:openConfig", []), /Unexpected MCP/);
  assert.equal(opened.length, 1);
});

test("desktop chat records append exact UTF-8 lines concurrently and reject escaping log paths", async () => {
  const f = await fixture(),
    d = createDispatcher(f.options),
    log = path.join(f.dir, "logs", "chat", "records.jsonl");
  const lines = Array.from(
    { length: 12 },
    (_, id) => JSON.stringify({ id, text: "真实聊天记录" }) + "\n",
  );
  await Promise.all(lines.map((jsonLine) => d("io:appendRecord", [{ filePath: log, jsonLine }])));
  const records = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    records.map((r) => r.id).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, id) => id),
  );
  assert(records.every((r) => r.text === "真实聊天记录"));
  assert.equal(
    await d("io:appendRecord", [{ filePath: log, jsonLine: "NO_ADDED_NEWLINE" }]),
    undefined,
  );
  assert((await fs.readFile(log, "utf8")).endsWith("NO_ADDED_NEWLINE"));
  await assert.rejects(
    d("io:appendRecord", [{ filePath: path.join(f.dir, "settings.json"), jsonLine: "BAD" }]),
    /inside application logs/,
  );
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wb-log-outside-"));
  await fs.symlink(outside, path.join(f.dir, "logs", "escape"));
  await assert.rejects(
    d("io:appendRecord", [
      { filePath: path.join(f.dir, "logs", "escape", "bad.jsonl"), jsonLine: "BAD" },
    ]),
    /inside application logs/,
  );
  await assert.rejects(fs.access(path.join(outside, "bad.jsonl")));
});

test("desktop MCP App adapter opens after standard tool result and skips denied result", async () => {
  for (const allowed of [true, false]) {
    const f = await fixture(),
      backendFetch = f.options.fetchImpl,
      appRequests = [];
    const result = allowed
      ? { content: [{ type: "text", text: "MODEL_TOOL_RESULT" }] }
      : "Permission denied by user";
    f.options.fetchImpl = async (url, options) => {
      if (url.endsWith("/connectors/apps/notify-agent")) {
        appRequests.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            handled: true,
            appInstanceId: "app-instance",
            descriptor: {
              appInstanceId: "app-instance",
              appId: "server/view",
              appUrl: "http://127.0.0.1:18799/mcp-apps/app-instance/app.html",
            },
          }),
        };
      }
      if (url.endsWith("/connectors/apps/push-result")) {
        appRequests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ handled: true }) };
      }
      if (!url.endsWith("/chat")) return backendFetch(url, options);
      const packet = (event, data) =>
        new TextEncoder().encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
      return {
        ok: true,
        body: (async function* () {
          yield packet("tool", {
            name: "mcp_call",
            toolCallId: "execution",
            args: { serverId: "server", name: "view", arguments: { selection: 42 } },
          });
          assert.equal(appRequests.length, 0);
          yield packet("tool_result", { name: "mcp_call", toolCallId: "execution", result });
          yield packet("done", { message: { content: "Done" } });
        })(),
      };
    };
    const d = createDispatcher(f.options),
      session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
    assert.equal(
      (await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "Run tool" }]]))
        .stopReason,
      "end_turn",
    );
    if (allowed) {
      assert.equal(appRequests.length, 2);
      assert.equal(appRequests[0].sessionId, session.sessionId);
      assert.equal(appRequests[0].prefixedToolName, "view");
      assert.deepEqual(appRequests[0].rawInput, { selection: 42 });
      assert.deepEqual(appRequests[1].result, result);
      const event = f.events.find((event) => event.channel === "mcpApps:openHostRequested");
      assert.equal(event.result.appInstanceId, "app-instance");
      assert.equal(event.result.toolCallId, appRequests[0].toolCallId);
    } else {
      assert.equal(appRequests.length, 0);
      assert(!f.events.some((event) => event.channel === "mcpApps:openHostRequested"));
    }
  }
});

test("successful package creation explicitly refreshes lists without waiting for filesystem events", async () => {
  const f = await fixture(), backendFetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat")) return backendFetch(url, options);
    const packets = [
      ["tool_result", { name: "skill_instructions_create", result: { created: true, skillId: "created-skill" } }],
      ["tool_result", { name: "expert_package_create", result: { created: true, expertId: "created-expert" } }],
      ["tool_result", { name: "skill_instructions_create", result: "Permission denied by user" }],
      ["tool_result", { name: "expert_package_create", result: { error: "Creation failed" } }],
      ["done", { message: { content: "Finished" } }],
    ];
    const bytes = new TextEncoder().encode(packets.map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n").join(""));
    return { ok: true, body: (async function* () { yield bytes; })() };
  };
  const d = createDispatcher(f.options), session = await d("session:create", [{ cwd: f.dir, config: { mode: "craft" } }]);
  await d("session:sendMessage", [session.sessionId, [{ type: "text", text: "Create packages" }]]);
  const skillEvents = f.events.filter(e => e.channel === "skill:packagesChanged");
  const expertEvents = f.events.filter(e => e.channel === "expert:packagesChanged");
  assert.equal(skillEvents.length, 1);
  assert.equal(expertEvents.length, 1);
  assert.equal(skillEvents[0].result.skillId, "created-skill");
  assert.equal(expertEvents[0].result.expertId, "created-expert");
});

test("model request timeout is actionable and never marks a task completed", async () => {
 const f=await fixture(),base=f.options.fetchImpl;
 f.options.fetchImpl=async(url,options)=>{
  if(!url.endsWith('/chat'))return base(url,options);
  throw new DOMException('The operation was aborted due to timeout','TimeoutError');
 };
 const d=createDispatcher(f.options),session=await d('session:create',[{}]);
 await assert.rejects(d('session:sendMessage',[session.sessionId,[{type:'text',text:'timeout verification'}]]),error=>error.code==='LOCAL_REQUEST_TIMEOUT' && !error.message.includes('aborted due to timeout'));
 assert(f.events.some(e=>e.result?.type==='sessionStatusUpdate'&&e.result.status==='failed'));
 assert(!f.events.some(e=>e.result?.type==='sessionStatusUpdate'&&e.result.status==='completed'));
});

test('public expert catalog renders metadata and featured scenes without fetching instructions until summon', { skip: process.env.WORKBUDDY_PUBLIC_TESTS === "1" ? "Proprietary fixture excluded from public source release" : false }, async()=>{
 const f=await fixture(),base=f.options.fetchImpl;let promptFetches=0;
 const d=createDispatcher({...f.options,publicExpertCatalog:true,fetchImpl:async(url,options)=>{
  if(url.startsWith('https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/')){
   promptFetches++;assert.equal(options.redirect,'error');return {ok:true,text:async()=> 'Public expert instruction fixture'};
  }
  return base(url,options);
 }});
 const listed=await d('expert:getExperts');
 assert(listed.experts.length>=431);
 const expert=listed.experts.find(x=>x.id==='ContentCreator');assert(expert);assert.equal(expert.isCustom,false);assert(expert.avatar.startsWith(f.options.origin+'/expert-catalog-assets/'));
 assert((await d('expert:getCategories')).categories.some(x=>x.id==='06-ContentCreative'));
 assert((await d('expert:getFeaturedScenes')).scenes.some(x=>x.id==='content-creation'));
 const team=listed.experts.find(x=>x.id==='AiContentCreatorTeam');assert.equal(team.members.length,7);assert.deepEqual(team.members.map(m=>m.id),['ai-content-creator-team-lead','content-adapter','copywriter','creative-strategist','image-creator','video-editor','video-generator']);assert(team.members.every(m=>m.avatar.startsWith(f.options.origin+'/expert-catalog-assets/')));
 const teamDetail=await d('expert:getExpert',[{expertId:team.id}]);assert(teamDetail.expert.members.every(m=>m.avatar.startsWith(f.options.origin+'/expert-catalog-assets/')));
 assert.equal(team.runtimeAvailable,false);await assert.rejects(d('expert:summonExpert',[{expertId:team.id}]),/接入 DSH/);assert.equal(promptFetches,0);
 await d('expert:getExpert',[{expertId:'ContentCreator'}]);assert.equal(promptFetches,0);
 const summoned=await d('expert:summonExpert',[{expertId:'ContentCreator'}]);assert.equal(summoned.expert.prompt,'Public expert instruction fixture');assert.equal(promptFetches,1);
 await d('expert:summonExpert',[{expertId:'ContentCreator'}]);assert.equal(promptFetches,1);
});

test("registered custom teams remain searchable and refresh without claiming execution", async () => {
  const f = await fixture();
  const root = path.join(f.dir, "expert-config/plugins/marketplaces/my-experts/plugins/editor-team");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  const manifest = { name: "editor-team", expertType: "team", displayName: "编辑专家团", teamInfo: { leadAgent: "lead" }, members: [{ id: "lead", name: "主编", role: "lead", avatar: "avatars/lead.png" }] };
  const file = path.join(root, ".codebuddy-plugin/plugin.json");
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "agents/lead.md"), "Coordinate editing.");
  const d = createDispatcher({ ...f.options, dataDir: path.join(f.dir, "data") });
  const id = "custom-expert:editor-team";
  const listed = await d("expert:getExperts", []);
  assert.equal(listed.experts.find(e => e.id === id).expertType, "team");
  assert.match(listed.experts.find(e => e.id === id).members[0].avatar, /\/api\/expert-resources\/custom-expert%3Aeditor-team\/avatars\/lead\.png$/);
  assert.equal((await d("expert:getCustomExpert", [{ expertId: id }])).expert.name, "编辑专家团");
  await fs.writeFile(file, JSON.stringify({ ...manifest, displayName: "编辑专家团已更新" }));
  assert.equal((await d("expert:getCustomExpert", [{ expertId: id }])).expert.name, "编辑专家团已更新");
  await assert.rejects(d("expert:summonExpert", [{ expertId: id }]), /接入 DSH/);
});
