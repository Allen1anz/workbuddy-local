import test from "node:test";
import assert from "node:assert/strict";
import { createMcpAppInstances } from "./mcp-app-instances.mjs";

test("Agent MCP App notification opens once without repeating tool and consumes early result", async () => {
  let toolsCalled = 0;
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => {
      toolsCalled++;
      return { content: [] };
    },
    createUrls: urls,
  });
  assert.deepEqual(
    await gateway.notifyAgent({ toolCallId: "ordinary", prefixedToolName: "ordinary" }),
    { handled: false },
  );
  gateway.push(
    { sessionId: "one", toolCallId: "agent" },
    { content: [{ type: "text", text: "AGENT_RESULT" }] },
  );
  const params = {
    sessionId: "one",
    toolCallId: "agent",
    prefixedToolName: "view",
    rawInput: { count: 42 },
    conversationRequestId: "request",
  };
  const [first, second] = await Promise.all([
    gateway.notifyAgent(params),
    gateway.notifyAgent(params),
  ]);
  assert.equal(first.handled, true);
  assert.equal(first.appInstanceId, second.appInstanceId);
  assert.equal(first.descriptor.toolInput.count, 42);
  assert.equal((await gateway.awaitBootstrap(first.appInstanceId)).content[0].text, "AGENT_RESULT");
  assert.equal(gateway.get(first.appInstanceId).conversationRequestId, "request");
  assert.equal(toolsCalled, 0);
  gateway.dispose();
});

test("MCP App early-result buffer evicts oldest after 256 entries", async () => {
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => ({ content: [] }),
    createUrls: urls,
  });
  for (let id = 0; id < 257; id++)
    gateway.push({ toolCallId: "buffer-" + id }, { content: [{ type: "text", text: String(id) }] });
  const newest = await gateway.open({
    appId: app.mcpAppId,
    toolCallId: "buffer-256",
    bootstrapToolCall: false,
  });
  assert.equal((await gateway.awaitBootstrap(newest.appInstanceId)).content[0].text, "256");
  const oldest = await gateway.open({
    appId: app.mcpAppId,
    toolCallId: "buffer-0",
    bootstrapToolCall: false,
  });
  assert.equal(gateway.push({ toolCallId: "buffer-0" }, { content: [] }), true);
  await gateway.awaitBootstrap(oldest.appInstanceId);
  gateway.dispose();
});

test("early MCP App results buffer by session and legacy unscoped results drain once", async () => {
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => {
      throw Error("No bootstrap");
    },
    createUrls: urls,
  });
  const result = (text) => ({ content: [{ type: "text", text }] });
  assert.equal(gateway.push({ sessionId: "one", toolCallId: "same" }, result("ONE")), false);
  assert.equal(gateway.push({ sessionId: "two", toolCallId: "same" }, result("TWO")), false);
  const one = await gateway.open({
    appId: app.mcpAppId,
    sessionId: "one",
    toolCallId: "same",
    bootstrapToolCall: false,
  });
  const two = await gateway.open({
    appId: app.mcpAppId,
    sessionId: "two",
    toolCallId: "same",
    bootstrapToolCall: false,
  });
  assert.equal((await gateway.awaitBootstrap(one.appInstanceId)).content[0].text, "ONE");
  assert.equal((await gateway.awaitBootstrap(two.appInstanceId)).content[0].text, "TWO");
  assert.equal(gateway.push({ sessionId: "one", toolCallId: "same" }, result("DUPLICATE")), false);
  assert.equal(gateway.get(one.appInstanceId).toolResult.content[0].text, "ONE");
  gateway.push({ toolCallId: "legacy" }, result("LEGACY"));
  const legacy = await gateway.open({
    appId: app.mcpAppId,
    sessionId: "one",
    toolCallId: "legacy",
    bootstrapToolCall: false,
  });
  assert.equal((await gateway.awaitBootstrap(legacy.appInstanceId)).content[0].text, "LEGACY");
  gateway.dispose();
});

test("MCP App refresh reuses input, updates only on success and preserves closed state", async () => {
  let fail = false;
  const inputs = [];
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    createUrls: urls,
    callTool: async (_, input) => {
      inputs.push(input);
      if (fail) throw Error("REFRESH_FAILED");
      return { content: [{ type: "text", text: String(input.count) }] };
    },
  });
  const opened = await gateway.open({ appId: app.mcpAppId, bootstrapToolCall: false });
  assert.equal((await gateway.refresh(opened.appInstanceId)).content[0].text, "7");
  assert.equal((await gateway.refresh(opened.appInstanceId, { count: 11 })).content[0].text, "11");
  assert.equal((await gateway.refresh(opened.appInstanceId)).content[0].text, "11");
  fail = true;
  await assert.rejects(gateway.refresh(opened.appInstanceId, { count: 99 }), /REFRESH_FAILED/);
  assert.equal(gateway.get(opened.appInstanceId).toolInput.count, 11);
  assert.deepEqual(
    inputs.map((input) => input.count),
    [7, 11, 11, 99],
  );
  gateway.close(opened.appInstanceId);
  await assert.rejects(gateway.refresh(opened.appInstanceId), /Unknown MCP App instance/);
});

test("removed MCP App evicts instance and permits a fresh instance after reinstallation", async () => {
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => ({ content: [] }),
    createUrls: urls,
  });
  const params = {
    appId: app.mcpAppId,
    sessionId: "one",
    toolCallId: "same",
    bootstrapToolCall: false,
  };
  const opened = await gateway.open(params),
    waiting = gateway.awaitBootstrap(opened.appInstanceId);
  gateway.reconcile([]);
  assert.equal((await waiting).isError, true);
  assert.throws(() => gateway.get(opened.appInstanceId), /Unknown MCP App instance/);
  const replacement = await gateway.open(params);
  assert.notEqual(replacement.appInstanceId, opened.appInstanceId);
  gateway.dispose();
});

test("removing MCP App while HTML loads prevents late instance creation", async () => {
  let available = true,
    release,
    ready,
    hosts = 0;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const resource = new Promise((resolve) => {
    release = resolve;
  });
  const gateway = createMcpAppInstances({
    listApps: async () => (available ? [app] : []),
    resolveResource: async () => {
      ready();
      return resource;
    },
    callTool: async () => ({ content: [] }),
    createUrls: () => {
      hosts++;
      return urls("late");
    },
  });
  const opening = gateway.open({ appId: app.mcpAppId, bootstrapToolCall: false });
  const rejected = assert.rejects(opening, /definition no longer exists/);
  await started;
  available = false;
  gateway.reconcile([]);
  release({ html: "LATE" });
  await rejected;
  assert.equal(hosts, 0);
});

test("disposing MCP App gateway prevents a late resource from creating a host", async () => {
  let release,
    ready,
    hosts = 0;
  const loading = new Promise((resolve) => {
    ready = resolve;
  });
  const resource = new Promise((resolve) => {
    release = resolve;
  });
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => {
      ready();
      return resource;
    },
    callTool: async () => ({ content: [] }),
    createUrls: () => {
      hosts++;
      return urls("late");
    },
  });
  const opening = gateway.open({ appId: app.mcpAppId, bootstrapToolCall: false });
  const rejected = assert.rejects(opening, /gateway closed/);
  await loading;
  gateway.dispose();
  release({ html: "LATE_RESOURCE" });
  await rejected;
  assert.equal(hosts, 0);
  await assert.rejects(gateway.open({ appId: app.mcpAppId }), /gateway closed/);
});

test("disposing gateway settles external bootstrap waiters and removes instances", async () => {
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => ({ content: [] }),
    createUrls: urls,
  });
  const opened = await gateway.open({
    appId: app.mcpAppId,
    toolCallId: "pending",
    bootstrapToolCall: false,
  });
  const waiting = gateway.awaitBootstrap(opened.appInstanceId);
  gateway.dispose();
  assert.equal((await waiting).isError, true);
  assert.throws(() => gateway.get(opened.appInstanceId), /Unknown MCP App instance/);
});
const app = {
  mcpAppId: "server/view",
  mcpAppName: "server/view",
  serverId: "server",
  resourceUri: "ui://view",
  toolName: "view",
  prefixedToolName: "view",
  inputSchema: {
    $ref: "#/$defs/Input",
    $defs: { Input: { properties: { count: { default: 7 } } } },
  },
};
const urls = (id) => ({
  appUrl: `http://127.0.0.1/mcp-apps/${id}/app.html`,
  sandboxUrl: "http://127.0.0.1/mcp-apps/sandbox-proxy.html",
});

test("MCP App concurrent opens deduplicate within session and isolate same tool call across sessions", async () => {
  let resolveHtml,
    started = 0;
  const html = new Promise((resolve) => {
    resolveHtml = resolve;
  });
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => {
      started++;
      return html;
    },
    callTool: async (_, input) => ({ content: [{ type: "text", text: String(input.count) }] }),
    createUrls: urls,
  });
  const params = {
    appId: app.mcpAppId,
    sessionId: "one",
    toolCallId: "same",
    toolInput: { count: 9 },
  };
  const first = gateway.open(params),
    repeated = gateway.open(params);
  assert.equal(first, repeated);
  resolveHtml({ html: "<p>view</p>", uiMetadata: { prefersBorder: true } });
  const opened = await first;
  assert.equal(started, 1);
  assert.equal(gateway.view(opened.appInstanceId).resourceUri, "ui://view");
  assert.equal((await gateway.awaitBootstrap(opened.appInstanceId)).content[0].text, "9");
  assert.equal((await gateway.open(params)).appInstanceId, opened.appInstanceId);
  const other = await gateway.open({ ...params, sessionId: "two", toolInput: {} });
  assert.notEqual(other.appInstanceId, opened.appInstanceId);
  assert.equal((await gateway.awaitBootstrap(other.appInstanceId)).content[0].text, "7");
  gateway.close(opened.appInstanceId);
  assert.throws(() => gateway.get(opened.appInstanceId), /Unknown MCP App instance/);
  assert.equal(gateway.get(other.appInstanceId).sessionId, "two");
});

test("MCP App externally supplied bootstrap settles once and closed instances reject lookups", async () => {
  const gateway = createMcpAppInstances({
    listApps: async () => [app],
    resolveResource: async () => ({ html: "view" }),
    callTool: async () => {
      throw Error("Must not bootstrap");
    },
    createUrls: urls,
  });
  const params = {
    appId: app.mcpAppId,
    toolCallId: "external",
    sessionId: "one",
    bootstrapToolCall: false,
  };
  const opened = await gateway.open(params),
    result = { content: [{ type: "text", text: "FIRST" }] };
  assert.equal(gateway.push(params, result), true);
  assert.equal(gateway.push(params, { content: [] }), false);
  assert.equal(await gateway.awaitBootstrap(opened.appInstanceId), result);
  gateway.close(opened.appInstanceId);
  assert.equal(gateway.push(params, result), false);
  assert.throws(() => gateway.awaitBootstrap(opened.appInstanceId), /Unknown MCP App instance/);
});
