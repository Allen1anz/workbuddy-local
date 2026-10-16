import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpExtension } from "./mcp.mjs";
import { createAppServer } from "../server/app.mjs";
import { Client } from "@modelcontextprotocol/client";
import { LegacySSETransport } from "./mcp-sse.mjs";
test("legacy SSE performs real MCP initialize and tool listing with configured headers", async () => {
  let stream;
  const received = [];
  const server = http.createServer(async (req, res) => {
    received.push({ method: req.method, header: req.headers["x-proof"] });
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
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "sse-proof", version: "1" },
          }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: "SSE_RUNTIME_PROOF" }] }
          : { tools: [{ name: "sse_proof", inputSchema: { type: "object", properties: {} } }] };
    stream.write(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
        "\n\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "sse-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(
      new LegacySSETransport("http://127.0.0.1:" + server.address().port + "/sse", {
        headers: { "X-Proof": "sse-fixture" },
      }),
      { timeout: 5000 },
    );
    assert.equal((await client.listTools()).tools[0].name, "sse_proof");
    assert(received.every((r) => r.header === "sse-fixture"));
    await client.close();
    const dataDir = await mkdtemp(join(tmpdir(), "wb-sse-runtime-")),
      extension = mcpExtension(dataDir),
      app = createAppServer({
        dataDir,
        extraTools: extension.tools,
        extraRoutes: extension.routes,
      });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch("http://127.0.0.1:" + app.address().port + "/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SSE runtime",
          transport: "sse",
          url: "http://127.0.0.1:" + server.address().port + "/sse",
          headers: { "X-Proof": "sse-fixture" },
        }),
      });
      assert.equal(response.status, 201);
      const connector = await response.json();
      const list = extension.tools.find((t) => t.definition.function.name === "mcp_list"),
        call = extension.tools.find((t) => t.definition.function.name === "mcp_call");
      assert.equal((await list.handler({ serverId: connector.id }, {})).tools[0].name, "sse_proof");
      assert.equal(
        (await call.handler({ serverId: connector.id, name: "sse_proof", arguments: {} }, {}))
          .content[0].text,
        "SSE_RUNTIME_PROOF",
      );
      assert.equal(call.requiresApproval, true);
      assert(received.every((r) => r.header === "sse-fixture"));
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  } finally {
    await client.close();
    stream?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("legacy SSE rejects missing endpoint within timeout and closes only once", async () => {
  let stream;
  const server = http.createServer((req, res) => {
    stream = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": waiting\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = new LegacySSETransport("http://127.0.0.1:" + server.address().port + "/sse", {
    timeout: 50,
  });
  let closes = 0;
  transport.onclose = () => closes++;
  try {
    await assert.rejects(transport.start(), /timeout/);
    await transport.close();
    await transport.close();
    assert.equal(closes, 1);
    await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "test" }), /unavailable/);
  } finally {
    stream?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("legacy SSE parses UTF-8 and CRLF fragmented byte by byte and rejects cross origin endpoints", async () => {
  const transport = new LegacySSETransport("http://127.0.0.1/sse"),
    messages = [];
  transport.onmessage = (m) => messages.push(m);
  const bytes = new TextEncoder().encode(
    'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"text":"中文内容"}}\r\n\r\n',
  );
  await transport.read(
    (async function* () {
      for (const byte of bytes) yield Uint8Array.of(byte);
    })(),
  );
  assert.equal(messages[0].result.text, "中文内容");
  const unsafe = new LegacySSETransport("http://127.0.0.1/sse");
  await assert.rejects(
    unsafe.read(
      (async function* () {
        yield new TextEncoder().encode("event: endpoint\ndata: http://example.test/messages\n\n");
      })(),
    ),
    /changed origin/,
  );
});

test("cancelled SSE MCP tool call closes an outstanding request without waiting for tool timeout", async () => {
  let stream, called;
  const incoming = new Promise((resolve) => (called = resolve));
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    posts++;
    res.writeHead(202);
    res.end();
    if (message.id === undefined) return;
    if (message.method === "tools/call") {
      called();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "cancel-proof", version: "1" },
          }
        : { tools: [{ name: "wait_tool", inputSchema: { type: "object", properties: {} } }] };
    stream.write(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
        "\n\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "wb-sse-cancel-"));
  await writeFile(
    join(dir, "connectors.json"),
    JSON.stringify([
      {
        id: "cancel-proof",
        name: "Cancel proof",
        transport: "sse",
        url: "http://127.0.0.1:" + server.address().port + "/sse",
      },
    ]),
  );
  const extension = mcpExtension(dir),
    controller = new AbortController(),
    tool = extension.tools.find((t) => t.definition.function.name === "mcp_call");
  let operation;
  try {
    operation = tool.handler(
      { serverId: "cancel-proof", name: "wait_tool", arguments: {} },
      { signal: controller.signal },
    );
    const rejection = assert.rejects(operation);
    await incoming;
    controller.abort();
    let timer;
    try {
      await Promise.race([
        rejection,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Cancellation did not settle")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert(posts >= 3);
    assert.equal(controller.signal.aborted, true);
  } finally {
    controller.abort();
    stream?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cancelled SSE connection settles before endpoint handshake arrives", async () => {
  let stream, connected;
  const incoming = new Promise((resolve) => (connected = resolve));
  const server = http.createServer((req, res) => {
    stream = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": pending endpoint\n\n");
    connected();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "wb-sse-handshake-cancel-"));
  await writeFile(
    join(dir, "connectors.json"),
    JSON.stringify([
      {
        id: "handshake",
        name: "Handshake",
        transport: "sse",
        url: "http://127.0.0.1:" + server.address().port + "/sse",
      },
    ]),
  );
  const controller = new AbortController(),
    tool = mcpExtension(dir).tools.find((t) => t.definition.function.name === "mcp_list");
  try {
    const operation = tool.handler({ serverId: "handshake" }, { signal: controller.signal }),
      rejection = assert.rejects(operation);
    await incoming;
    controller.abort();
    let timer;
    try {
      await Promise.race([
        rejection,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Handshake cancellation did not settle")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    controller.abort();
    stream?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("shared SSE connection isolates cancellation and keeps another outstanding call usable", async () => {
  let stream,
    waitReady,
    survivorReady,
    survivorId,
    initializations = 0,
    toolsVisible = true;
  const waitIncoming = new Promise((resolve) => (waitReady = resolve)),
    survivorIncoming = new Promise((resolve) => (survivorReady = resolve));
  const reply = (id, text) =>
    stream.write(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }) +
        "\n\n",
    );
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
    if (message.method === "tools/call") {
      if (message.params.arguments.mode === "cancel") waitReady();
      else {
        survivorId = message.id;
        survivorReady();
      }
      return;
    }
    if (message.method === "initialize") initializations++;
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "shared-proof", version: "1" },
          }
        : {
            tools: [
              {
                name: "shared_tool",
                _meta: { ui: { resourceUri: "ui://shared-proof", visibility: ["app"] } },
                inputSchema: { type: "object", properties: { mode: { type: "string" } } },
              },
            ],
          };
    if (message.method === "tools/list" && !toolsVisible) result.tools = [];
    stream.write(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
        "\n\n",
    );
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const dataDir = await mkdtemp(join(tmpdir(), "wb-shared-sse-")),
    extension = mcpExtension(dataDir),
    app = createAppServer({ dataDir, extraTools: extension.tools, extraRoutes: extension.routes });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + app.address().port;
  const request = async (route, method = "GET", body) =>
    fetch(origin + "/api/connectors" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const controller = new AbortController();
  try {
    const connector = await (
      await request("", "POST", {
        name: "Shared SSE",
        transport: "sse",
        url: "http://127.0.0.1:" + remote.address().port + "/sse",
      })
    ).json();
    assert((await request("/" + connector.id + "/connect", "POST", {})).ok);
    const apps = await (await request("/apps")).json();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].mcpAppId, connector.id + "/shared_tool");
    assert.equal(apps[0].resourceUri, "ui://shared-proof");
    assert.deepEqual(apps[0].visibility, ["app"]);
    assert.equal(apps[0].inputSchema.type, "object");

    const call = extension.tools.find((tool) => tool.definition.function.name === "mcp_call"),
      waiting = call.handler(
        { serverId: connector.id, name: "shared_tool", arguments: { mode: "cancel" } },
        { signal: controller.signal },
      ),
      rejected = assert.rejects(waiting);
    const survivor = call.handler(
      { serverId: connector.id, name: "shared_tool", arguments: { mode: "survive" } },
      {},
    );
    await Promise.all([waitIncoming, survivorIncoming]);
    controller.abort();
    await rejected;
    reply(survivorId, "SURVIVING_SHARED_CONNECTION");
    assert.equal((await survivor).content[0].text, "SURVIVING_SHARED_CONNECTION");
    assert.equal(initializations, 1);
    assert.equal((await (await request("")).json())[0].status, "connected");
    async function notifyAndWait(visible) {
      toolsVisible = visible;
      stream.write(
        "event: message\ndata: " +
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) +
          "\n\n",
      );
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if ((await (await request("/apps")).json()).length === (visible ? 1 : 0)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error("MCP App inventory did not react to tools/list_changed");
    }
    await notifyAndWait(false);
    await notifyAndWait(true);
    assert.equal(initializations, 1);

    assert((await request("/" + connector.id, "PUT", { disabledTools: ["shared_tool"] })).ok);
    assert.deepEqual(await (await request("/apps")).json(), []);
    assert((await request("/" + connector.id, "PUT", { disabledTools: [] })).ok);
    assert.equal((await (await request("/apps")).json()).length, 1);
    assert((await request("/" + connector.id, "PUT", { disabled: true })).ok);
    assert.deepEqual(await (await request("/apps")).json(), []);
  } finally {
    controller.abort();
    await extension.close();
    await new Promise((resolve) => app.close(resolve));
    stream?.end();
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
  }
});

test(
  "cancelling a waiter during real pooled SSE handshake preserves reconnect and survivor",
  { timeout: 5000 },
  async () => {
    let stream,
      ready,
      initializations = 0,
      connections = 0;
    const incoming = new Promise((resolve) => (ready = resolve));
    const remote = http.createServer(async (req, res) => {
      if (req.method === "GET") {
        connections++;
        stream = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        ready();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      res.writeHead(202);
      res.end();
      if (message.id === undefined) return;
      if (message.method === "initialize") initializations++;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "handshake-proof", version: "1" },
            }
          : {
              tools: [{ name: "handshake_tool", inputSchema: { type: "object", properties: {} } }],
            };
      stream.write(
        "event: message\ndata: " +
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
          "\n\n",
      );
    });
    await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const dataDir = await mkdtemp(join(tmpdir(), "wb-pooled-handshake-")),
      extension = mcpExtension(dataDir),
      app = createAppServer({
        dataDir,
        extraTools: extension.tools,
        extraRoutes: extension.routes,
      }),
      controller = new AbortController();
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + app.address().port + "/api/connectors";
    try {
      const connector = await (
        await fetch(origin, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Handshake SSE",
            transport: "sse",
            url: "http://127.0.0.1:" + remote.address().port + "/sse",
          }),
        })
      ).json();
      const connecting = fetch(origin + "/" + connector.id + "/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await incoming;
      assert.equal((await (await fetch(origin)).json())[0].status, "connecting");
      const list = extension.tools.find((tool) => tool.definition.function.name === "mcp_list");
      const cancelled = list.handler({ serverId: connector.id }, { signal: controller.signal });
      const rejected = assert.rejects(cancelled);
      const survivor = list.handler({ serverId: connector.id }, {});
      controller.abort();
      await rejected;
      assert.equal(connections, 1);
      assert.equal((await (await fetch(origin)).json())[0].status, "connecting");
      stream.write("event: endpoint\ndata: /messages\n\n");
      assert((await connecting).ok);
      assert.equal((await survivor).tools[0].name, "handshake_tool");
      assert.equal(initializations, 1);
      assert.equal(connections, 1);
      assert.equal((await (await fetch(origin)).json())[0].status, "connected");
    } finally {
      controller.abort();
      await extension.close();
      await new Promise((resolve) => app.close(resolve));
      stream?.end();
      remote.closeAllConnections();
      await new Promise((resolve) => remote.close(resolve));
    }
  },
);
