import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mcpExtension } from "./mcp.mjs";
import { createAppServer } from "../server/app.mjs";

const reaDispatcher = resolve(dirname(fileURLToPath(import.meta.url)), "../../rea-local/scripts/rea.mjs");
test("MCP stdio connects to installed REA, lists tools, calls target-free session and hides secrets", { skip: existsSync(reaDispatcher) ? false : "External REA checkout is not bundled" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-"));
  const extension = mcpExtension(dir);
  const app = createAppServer({
    dataDir: dir,
    extraTools: extension.tools,
    extraRoutes: extension.routes,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (url, method = "GET", body) => {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const server = await request("/api/connectors", "POST", {
      name: "REA protocol verification",
      transport: "stdio",
      command: process.execPath,
      args: [reaDispatcher, "mcp"],
      env: { WB_TEST_KEY: "private-value" },
    });
    assert.deepEqual(server.envKeys, ["WB_TEST_KEY"]);
    assert.equal(server.env, undefined);
    const connected = await request(`/api/connectors/${server.id}/connect`, "POST", {});
    assert.ok(connected.tools.some((tool) => tool.name === "binary_session"));
    assert.ok(connected.tools.length >= 134);
    const caller = extension.tools.find((tool) => tool.definition.function.name === "mcp_call");
    assert.equal(caller.requiresApproval, true);
    const result = await caller.handler(
      { serverId: server.id, name: "binary_session", arguments: {} },
      {},
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content.length > 0);
    const config = JSON.parse(await readFile(join(dir, "connectors.json"), "utf8"));
    assert.equal(config[0].env.WB_TEST_KEY, "private-value");
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
  }
});

test("HTTP connector headers persist privately and public list reveals only header names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-http-headers-")),
    extension = mcpExtension(dir),
    app = createAppServer({
      dataDir: dir,
      extraTools: extension.tools,
      extraRoutes: extension.routes,
    });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port;
  try {
    const response = await fetch(base + "/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Header proof",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "fixture-private-header", "X-Test": "proof" },
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(result.headerKeys, ["Authorization", "X-Test"]);
    assert(!JSON.stringify(result).includes("fixture-private-header"));
    const listed = await (await fetch(base + "/api/connectors")).json();
    assert(!JSON.stringify(listed).includes("fixture-private-header"));
    const stored = JSON.parse(await readFile(join(dir, "connectors.json"), "utf8"));
    assert.equal(stored[0].headers.Authorization, "fixture-private-header");
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
  }
});

test("HTTP MCP initialization list and call transmit explicit headers and preserve approval requirements", async () => {
  const received = [],
    remote = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      received.push({
        method: message.method,
        authorization: req.headers.authorization,
        test: req.headers["x-test"],
      });
      if (message.id === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      let result;
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "header-proof", version: "1.0" },
        };
      else if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "echo_proof",
              description: "Local proof",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        };
      else if (message.method === "tools/call")
        result = { content: [{ type: "text", text: message.params.arguments.text }] };
      else result = {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-http-runtime-")),
    extension = mcpExtension(dir),
    app = createAppServer({
      dataDir: dir,
      extraTools: extension.tools,
      extraRoutes: extension.routes,
    });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch("http://127.0.0.1:" + app.address().port + "/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Runtime header proof",
        transport: "http",
        url: "http://127.0.0.1:" + remote.address().port + "/mcp",
        apiKey: "ignored-default-key",
        headers: { Authorization: "fixture-explicit-auth", "X-Test": "runtime-proof" },
      }),
    });
    assert.equal(response.status, 201);
    const connector = await response.json();
    const connectResponse = await fetch(
      "http://127.0.0.1:" + app.address().port + "/api/connectors/" + connector.id + "/connect",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    assert(connectResponse.ok);
    const live = await (
      await fetch("http://127.0.0.1:" + app.address().port + "/api/connectors")
    ).json();
    assert.equal(live[0].status, "connected");
    const initializations = received.filter((r) => r.method === "initialize").length;
    const list = extension.tools.find((t) => t.definition.function.name === "mcp_list"),
      call = extension.tools.find((t) => t.definition.function.name === "mcp_call");
    assert.equal(list.requiresApproval, true);
    assert.equal(call.requiresApproval, true);
    assert.equal((await list.handler({ serverId: connector.id }, {})).tools[0].name, "echo_proof");
    const result = await call.handler(
      { serverId: connector.id, name: "echo_proof", arguments: { text: "HTTP_MCP_RUNTIME_PROOF" } },
      {},
    );
    assert.equal(result.content[0].text, "HTTP_MCP_RUNTIME_PROOF");
    assert.equal(received.filter((r) => r.method === "initialize").length, initializations);

    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const rows = received.filter((r) => r.method === method);
      assert(rows.length > 0);
      assert(
        rows.every(
          (r) => r.authorization === "fixture-explicit-auth" && r.test === "runtime-proof",
        ),
      );
    }
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
                    {
                      id: "mcp-approval-proof",
                      type: "function",
                      function: {
                        name: "mcp_call",
                        arguments: JSON.stringify({
                          serverId: connector.id,
                          name: "echo_proof",
                          arguments: { text: "APPROVED_HTTP_MCP_PROOF" },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      else {
        assert(
          body.messages.some(
            (m) => m.role === "tool" && m.content.includes("APPROVED_HTTP_MCP_PROOF"),
          ),
        );
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "MODEL_AFTER_APPROVAL" } }],
          }),
        );
      }
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const appBase = "http://127.0.0.1:" + app.address().port,
      api = async (route, method = "GET", body) =>
        fetch(appBase + "/api" + route, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
    try {
      await api("/config", "PUT", {
        model: "approval-test",
        baseURL: "http://127.0.0.1:" + model.address().port + "/v1",
      });
      const session = await (
          await api("/sessions", "POST", { title: "MCP approval proof" })
        ).json(),
        beforeCalls = received.filter((r) => r.method === "tools/call").length;
      const response = await api("/sessions/" + session.id + "/chat", "POST", {
        message: "Use MCP proof",
        mode: "craft",
      });
      let stream = "",
        approved = false;
      for await (const chunk of response.body) {
        stream += new TextDecoder().decode(chunk);
        if (!approved && stream.includes("event: approval")) {
          assert.equal(received.filter((r) => r.method === "tools/call").length, beforeCalls);
          const pending = await (await api("/approvals")).json();
          assert.equal(pending.length, 1);
          assert.equal(pending[0].name, "mcp_call");
          const approval = await api("/approvals/" + pending[0].id, "POST", {
            decision: "approve",
          });
          assert(approval.ok);
          approved = true;
        }
      }
      assert.equal(approved, true);
      assert(stream.includes("MODEL_AFTER_APPROVAL"));
      assert(!stream.includes("event: error"));
      assert.equal(received.filter((r) => r.method === "tools/call").length, beforeCalls + 1);
      assert.equal((await (await api("/approvals")).json()).length, 0);
    } finally {
      await new Promise((resolve) => model.close(resolve));
    }
    await api("/connectors/" + connector.id, "PUT", { disabledTools: ["echo_proof"] });
    assert.deepEqual((await list.handler({ serverId: connector.id }, {})).tools, []);
    const cachedServers = await (await api("/connectors")).json();
    assert.deepEqual(cachedServers[0].tools, [
      { name: "echo_proof", description: "Local proof", enabled: false },
    ]);
    const trafficBeforeToolCall = received.length;
    await assert.rejects(
      call.handler(
        { serverId: connector.id, name: "echo_proof", arguments: { text: "blocked tool" } },
        {},
      ),
      /工具已停用/,
    );
    assert.equal(received.length, trafficBeforeToolCall);
    await api("/connectors/" + connector.id, "PUT", { disabledTools: [] });
    assert.equal(
      (
        await call.handler(
          { serverId: connector.id, name: "echo_proof", arguments: { text: "REENABLED_TOOL" } },
          {},
        )
      ).content[0].text,
      "REENABLED_TOOL",
    );
    await api("/connectors/" + connector.id, "PUT", {
      url: "http://127.0.0.1:" + remote.address().port + "/changed-mcp",
    });
    assert.equal((await (await api("/connectors")).json())[0].tools, undefined);
    const trafficBeforeDisable = received.length;
    await api("/connectors/" + connector.id, "PUT", { disabled: true });
    await assert.rejects(list.handler({ serverId: connector.id }, {}), /已停用/);
    await assert.rejects(
      call.handler(
        { serverId: connector.id, name: "echo_proof", arguments: { text: "blocked" } },
        {},
      ),
      /已停用/,
    );
    assert.equal(received.length, trafficBeforeDisable);
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => remote.close(resolve));
  }
});

test("concurrent connector saves retain every entry and merge independent updates without torn JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-concurrent-")),
    extension = mcpExtension(dir),
    app = createAppServer({
      dataDir: dir,
      extraTools: extension.tools,
      extraRoutes: extension.routes,
    });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port,
    request = (route, method = "GET", body) =>
      fetch(base + "/api/connectors" + route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  try {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request("", "POST", {
          name: "Concurrent " + index,
          transport: "http",
          url: "https://example.test/mcp/" + index,
        }),
      ),
    );
    assert(responses.every((r) => r.status === 201));
    const entries = await (await request("")).json();
    assert.equal(entries.length, 12);
    assert.equal(new Set(entries.map((e) => e.name)).size, 12);
    const id = entries[0].id;
    const updates = await Promise.all([
      request("/" + id, "PUT", { disabled: true }),
      request("/" + id, "PUT", { headers: { "X-Proof": "merged" } }),
      request("/" + id, "PUT", { disabledTools: ["blocked_tool"] }),
    ]);
    assert(updates.every((r) => r.ok));
    const stored = JSON.parse(await readFile(join(dir, "connectors.json"), "utf8")),
      entry = stored.find((e) => e.id === id);
    assert.equal(stored.length, 12);
    assert.equal(entry.disabled, true);
    assert.equal(entry.headers["X-Proof"], "merged");
    assert.deepEqual(entry.disabledTools, ["blocked_tool"]);
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
  }
});

test("whole connector configuration validates before atomic replacement and preserves IDs and omitted secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-config-")),
    extension = mcpExtension(dir),
    app = createAppServer({
      dataDir: dir,
      extraTools: extension.tools,
      extraRoutes: extension.routes,
    });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.address().port,
    put = (entries) =>
      fetch(base + "/api/connectors/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
  try {
    assert(
      (
        await put([
          {
            name: "kept",
            transport: "http",
            url: "https://example.test/mcp",
            apiKey: "fixture-private-key",
          },
        ])
      ).ok,
    );
    const before = await readFile(join(dir, "connectors.json"), "utf8");
    const id = JSON.parse(before)[0].id;
    const failed = await put([
      { name: "kept", transport: "http", url: "https://example.test/changed" },
      { name: "invalid", transport: "http", url: "invalid" },
    ]);
    assert.equal(failed.status, 400);
    assert.equal(await readFile(join(dir, "connectors.json"), "utf8"), before);
    assert(
      (
        await put([
          { name: "kept", transport: "http", url: "https://example.test/changed" },
          { name: "added", transport: "stdio", command: "node", args: [] },
        ])
      ).ok,
    );
    const next = JSON.parse(await readFile(join(dir, "connectors.json"), "utf8"));
    assert.equal(next.length, 2);
    assert.equal(next[0].id, id);
    assert.equal(next[0].apiKey, "fixture-private-key");
    const document = await (await fetch(base + "/api/connectors/config")).json();
    assert.equal(document.filePath, join(dir, "mcp.json"));
    const user = JSON.parse(document.content);
    user.mcpServers.kept.url = "https://example.test/external-edit";
    await writeFile(document.filePath, JSON.stringify(user));
    const changed = await (await fetch(base + "/api/connectors")).json();
    assert.equal(
      changed.find((entry) => entry.name === "kept").url,
      "https://example.test/external-edit",
    );
    assert.equal(changed.find((entry) => entry.name === "kept").id, id);
    await writeFile(document.filePath, "{ broken external config");
    assert.equal(
      (await (await fetch(base + "/api/connectors")).json()).find((entry) => entry.name === "kept")
        .url,
      "https://example.test/external-edit",
    );
    const broken = await (await fetch(base + "/api/connectors/config")).json();
    assert.equal(broken.content, "{ broken external config");
    assert(broken.validationError);
  } finally {
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
  }
});
