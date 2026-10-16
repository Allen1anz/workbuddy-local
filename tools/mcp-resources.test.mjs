import { createRequire } from "node:module";
const { createDispatcher } = createRequire(import.meta.url)("../desktop/dispatcher.cjs");
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpExtension } from "./mcp.mjs";
import { createAppServer } from "../server/app.mjs";

test("configured MCP resource list and HTML read reuse connection and respect disabled server", async () => {
  let stream,
    initializes = 0;
  const reads = [];
  const remote = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    res.writeHead(202);
    res.end();
    if (message.id === undefined) return;
    let result;
    if (message.method === "initialize") {
      initializes++;
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "resource-proof", version: "1" },
      };
    } else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "view",
            inputSchema: { type: "object" },
            _meta: { ui: { resourceUri: "ui://proof" } },
          },
          { name: "helper", inputSchema: { type: "object" } },
        ],
      };
    else if (message.method === "resources/list")
      result = { resources: [{ name: "View", uri: "ui://proof", mimeType: "text/html" }] };
    else if (message.method === "resources/templates/list")
      result = { resourceTemplates: [{ name: "Detail", uriTemplate: "ui://detail/{id}" }] };
    else if (message.method === "prompts/list")
      result = { prompts: [{ name: "Explain", description: "Resource explanation" }] };
    else if (message.method === "resources/read") {
      reads.push(message.params.uri);
      result = {
        contents: [
          {
            uri: message.params.uri,
            mimeType: "text/html",
            text: "<html>真实资源</html>",
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      };
    } else if (message.method === "tools/call")
      result = { content: [{ type: "text", text: "BOOTSTRAP_RESOURCE_PROOF" }] };
    else throw Error("Unexpected fixture method " + message.method);
    const listField = {
      "tools/list": "tools",
      "resources/list": "resources",
      "resources/templates/list": "resourceTemplates",
      "prompts/list": "prompts",
    }[message.method];
    if (listField) {
      if (message.params?.cursor === undefined) {
        if (listField === "tools") result.tools = result.tools.slice(0, 1);
        result.nextCursor = "second-page";
      } else {
        assert.equal(message.params.cursor, "second-page");
        const second = {
          tools: [{ name: "helper", inputSchema: { type: "object" } }],
          resources: [{ name: "Second", uri: "ui://second" }],
          resourceTemplates: [{ name: "Second", uriTemplate: "ui://second/{id}" }],
          prompts: [{ name: "Second" }],
        };
        result = { [listField]: second[listField] };
      }
    }
    stream.write(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
        "\n\n",
    );
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const dataDir = await mkdtemp(join(tmpdir(), "wb-mcp-resources-")),
    extension = mcpExtension(dataDir),
    app = createAppServer({ dataDir, extraTools: extension.tools, extraRoutes: extension.routes });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + app.address().port + "/api/connectors";
  const request = (suffix, method = "GET", body) =>
    fetch(origin + suffix, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const connector = await (
      await request("", "POST", {
        name: "Resource SSE",
        transport: "sse",
        url: "http://127.0.0.1:" + remote.address().port + "/sse",
      })
    ).json();
    assert((await request("/" + connector.id + "/connect", "POST", {})).ok);
    const endpoint = "/" + connector.id + "/resources";
    assert.equal((await (await request(endpoint)).json()).resources[0].uri, "ui://proof");
    const response = await request(endpoint, "POST", { uri: "ui://proof" });
    assert(response.ok);
    const contents = (await response.json()).contents;
    assert.equal(contents[0].text, "<html>真实资源</html>");
    assert.equal(contents[0]._meta.ui.prefersBorder, true);
    const appId = connector.id + "/view";
    const resolvedResponse = await request("/apps/resolve", "POST", { appId });
    assert(resolvedResponse.ok);
    const resolved = await resolvedResponse.json();
    assert.equal(resolved.html, "<html>真实资源</html>");
    assert.equal(resolved.mimeType, "text/html");
    assert.equal(resolved.uiMetadata.prefersBorder, true);
    assert.equal((await request("/apps/resolve", "POST", { appId: "missing" })).status, 400);
    assert.deepEqual(reads, ["ui://proof", "ui://proof"]);
    assert.equal(initializes, 1);
    const dispatcher = createDispatcher({ dataDir, origin: origin.replace("/api/connectors", "") });
    const params = { appId, sessionId: "resource-session", toolCallId: "open-proof" };
    const [opened, duplicate] = await Promise.all([
      dispatcher("mcpApps:openHostApp", [params]),
      dispatcher("mcpApps:openHostApp", [params]),
    ]);
    assert.equal(opened.appInstanceId, duplicate.appInstanceId);
    assert.notEqual(new URL(opened.appUrl).port, String(app.address().port));
    assert.equal(await (await fetch(opened.appUrl)).text(), "<html>真实资源</html>");
    assert.equal((await fetch(new URL("/api/sessions", opened.appUrl))).status, 404);
    assert(
      (await (await fetch(opened.sandboxUrl)).text()).includes(
        "ui/notifications/sandbox-proxy-ready",
      ),
    );
    assert.equal(
      (await dispatcher("mcpApps:getViewResource", [opened.appInstanceId])).resourceUri,
      "ui://proof",
    );
    const tools = await dispatcher("mcpApps:listTools", [opened.appInstanceId]);
    assert.equal(await dispatcher("mcpApps:getModelContextUpdate", [opened.appInstanceId]), null);
    assert.deepEqual(
      await dispatcher("mcpApps:recordModelContextUpdate", [
        opened.appInstanceId,
        {
          content: [null, "invalid", { type: "text", text: "APP_CONTEXT_REAL" }],
          structuredContent: { selected: 42 },
          ignored: true,
        },
      ]),
      { handled: true },
    );
    const context = await dispatcher("mcpApps:getModelContextUpdate", [opened.appInstanceId]);
    assert.equal(typeof context.timestamp, "number");
    assert.deepEqual(context.content, [{ type: "text", text: "APP_CONTEXT_REAL" }]);
    assert.deepEqual(context.structuredContent, { selected: 42 });
    assert.equal(context.ignored, undefined);
    assert.equal(tools.tools.length, 2);
    assert.equal(tools.tools[1].name, "helper");
    assert.equal(
      (await dispatcher("mcpApps:listResources", [opened.appInstanceId])).resources[1].uri,
      "ui://second",
    );
    assert.equal(
      (await dispatcher("mcpApps:listResourceTemplates", [opened.appInstanceId]))
        .resourceTemplates[1].uriTemplate,
      "ui://second/{id}",
    );
    assert.equal(
      (await dispatcher("mcpApps:listPrompts", [opened.appInstanceId])).prompts[1].name,
      "Second",
    );
    assert.equal(tools.tools[0].name, "view");
    assert.equal(tools.tools[0].inputSchema.type, "object");
    assert.equal(tools.tools[0]._meta.ui.resourceUri, "ui://proof");
    assert.equal(
      (await dispatcher("mcpApps:listResources", [opened.appInstanceId])).resources[0].uri,
      "ui://proof",
    );
    assert.equal(
      (await dispatcher("mcpApps:listResourceTemplates", [opened.appInstanceId]))
        .resourceTemplates[0].uriTemplate,
      "ui://detail/{id}",
    );
    assert.equal(
      (await dispatcher("mcpApps:listPrompts", [opened.appInstanceId])).prompts[0].name,
      "Explain",
    );
    assert.equal(
      (await dispatcher("mcpApps:awaitBootstrapToolResult", [opened.appInstanceId])).content[0]
        .text,
      "BOOTSTRAP_RESOURCE_PROOF",
    );
    assert.equal(
      (await dispatcher("mcpApps:refreshToolResult", [opened.appInstanceId, { refresh: true }]))
        .content[0].text,
      "BOOTSTRAP_RESOURCE_PROOF",
    );
    assert.equal(
      (await dispatcher("mcpApps:readResource", [opened.appInstanceId, "ui://extra"])).contents[0]
        .uri,
      "ui://extra",
    );
    assert.equal(
      (await dispatcher("mcpApps:callTool", [opened.appInstanceId, "helper", { proof: true }]))
        .content[0].text,
      "BOOTSTRAP_RESOURCE_PROOF",
    );
    await assert.rejects(
      dispatcher("mcpApps:callTool", [opened.appInstanceId, "missing", {}]),
      /does not declare/,
    );
    assert((await request("/" + connector.id, "PUT", { disabledTools: ["helper"] })).ok);
    await assert.rejects(
      dispatcher("mcpApps:callTool", [opened.appInstanceId, "helper", {}]),
      /停用/,
    );
    assert.deepEqual(await dispatcher("mcpApps:closeHostApp", [opened.appInstanceId]), {
      ok: true,
    });
    assert.equal((await fetch(opened.appUrl)).status, 404);
    assert.equal(await dispatcher("mcpApps:getModelContextUpdate", [opened.appInstanceId]), null);
    assert.deepEqual(
      await dispatcher("mcpApps:recordModelContextUpdate", [opened.appInstanceId, { content: [] }]),
      { handled: false },
    );
    await assert.rejects(
      dispatcher("mcpApps:callTool", [opened.appInstanceId, "helper", {}]),
      /Unknown MCP App instance/,
    );
    await assert.rejects(
      dispatcher("mcpApps:readResource", [opened.appInstanceId, "ui://proof"]),
      /Unknown MCP App instance/,
    );

    assert.equal((await request(endpoint, "POST", { uri: "" })).status, 400);
    const active = await dispatcher("mcpApps:openHostApp", [
      { ...params, bootstrapToolCall: false, toolCallId: "external-result" },
    ]);
    assert.deepEqual(
      await dispatcher("mcpApps:notifyToolCallUpdate", [
        "external-result",
        { content: [{ type: "text", text: "PUSHED_RESULT" }] },
      ]),
      { handled: true },
    );
    assert.equal(
      (await dispatcher("mcpApps:awaitBootstrapToolResult", [active.appInstanceId])).content[0]
        .text,
      "PUSHED_RESULT",
    );
    assert.deepEqual(
      await dispatcher("mcpApps:notifyToolCallUpdate", ["external-result", { content: [] }]),
      { handled: false },
    );
    assert.deepEqual(
      await dispatcher("mcpApps:notifyToolCallUpdate", [
        "agent-rpc",
        { content: [{ type: "text", text: "EARLY_AGENT_RPC" }] },
      ]),
      { handled: false },
    );
    const notified = await dispatcher("mcpApps:notifyToolCall", [
      {
        sessionId: "agent-session",
        toolCallId: "agent-rpc",
        prefixedToolName: "view",
        serverId: connector.id,
        rawInput: { agent: true },
      },
    ]);
    assert.equal(notified.handled, true);
    assert.equal(
      (await dispatcher("mcpApps:awaitBootstrapToolResult", [notified.appInstanceId])).content[0]
        .text,
      "EARLY_AGENT_RPC",
    );
    assert.equal((await fetch(notified.descriptor.appUrl)).status, 200);
    await dispatcher("mcpApps:closeHostApp", [notified.appInstanceId]);
    assert((await request("/" + connector.id, "PUT", { disabled: true })).ok);
    assert.equal((await fetch(active.appUrl)).status, 404);
    await assert.rejects(
      dispatcher("mcpApps:getViewResource", [active.appInstanceId]),
      /Unknown MCP App instance/,
    );
    assert.equal((await request(endpoint)).status, 400);
    assert.equal((await request(endpoint, "POST", { uri: "ui://proof" })).status, 400);
    assert.equal((await request("/apps/resolve", "POST", { appId })).status, 400);
    assert.deepEqual(reads, ["ui://proof", "ui://proof", "ui://proof", "ui://extra", "ui://proof"]);
    await extension.close();
    await assert.rejects(fetch(opened.sandboxUrl));
    await assert.rejects(dispatcher("mcpApps:openHostApp", [params]), /gateway closed/);
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
    stream?.end();
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
  }
});
