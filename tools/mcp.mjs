import { collectMcpList } from "./mcp-list.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createMcpAppInstances } from "./mcp-app-instances.mjs";
import { createMcpAppHttpHandler } from "./mcp-app-http.mjs";
import { resolveMcpAppResource, createMcpAppResourceResolver } from "./mcp-app-resource.mjs";
import { buildMcpAppCatalog, extractToolUiMetadata } from "./mcp-app-catalog.mjs";
import { createMcpPool } from "./mcp-pool.mjs";
import { createMcpStore } from "./mcp-store.mjs";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LegacySSETransport } from "./mcp-sse.mjs";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function validate(input) {
  if (!input || typeof input.name !== "string" || !input.name.trim())
    throw new Error("请填写连接器名称。");
  if (!["http", "stdio", "sse"].includes(input.transport))
    throw new Error("请选择 HTTP 或 stdio。");
  const server = { ...input, name: input.name.trim().slice(0, 100) };
  if (
    server.disabledTools !== undefined &&
    (!Array.isArray(server.disabledTools) ||
      server.disabledTools.some((name) => typeof name !== "string" || !name.trim()))
  )
    throw Error("Connector disabledTools must be tool names");
  if (server.disabled !== undefined && typeof server.disabled !== "boolean")
    throw Error("Connector disabled flag must be boolean");
  if (["http", "sse"].includes(server.transport)) {
    const url = new URL(server.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("请输入有效的 HTTP 地址，认证密钥请单独填写。");
    server.url = url.href;
    if (server.headers !== undefined) {
      if (
        !server.headers ||
        typeof server.headers !== "object" ||
        Array.isArray(server.headers) ||
        Object.values(server.headers).some((value) => typeof value !== "string")
      )
        throw Error("HTTP headers must be a string dictionary");
      new Headers(server.headers);
    }
  } else {
    if (typeof server.command !== "string" || !server.command.trim())
      throw new Error("请填写可执行程序路径。");
    if (!Array.isArray(server.args) || server.args.some((a) => typeof a !== "string"))
      throw new Error("参数必须为字符串数组。");
    if (
      server.env &&
      (typeof server.env !== "object" ||
        Array.isArray(server.env) ||
        Object.values(server.env).some((v) => typeof v !== "string"))
    )
      throw new Error("环境变量必须为字符串键值对象。");
  }
  return server;
}

function publicServer({ apiKey, env, headers, ...server }) {
  return {
    ...server,
    apiKeySet: Boolean(apiKey),
    envKeys: Object.keys(env || {}),
    headerKeys: Object.keys(headers || {}),
  };
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Explicitly configured MCP adapters; connecting stdio launches its program. */
export function mcpExtension(dataDir) {
  let closed = false,
    closing;
  const inventory = new Map();
  const describeServer = (entry) => ({
    ...publicServer(entry),
    ...pool.state(entry.id),
    ...(inventory.has(entry.id)
      ? {
          tools: inventory.get(entry.id).map(({ name, description }) => ({
            name,
            description,
            enabled: !entry.disabledTools?.includes(name),
          })),
        }
      : {}),
  });

  const store = createMcpStore(dataDir, {
    onExternalChange: async () => {
      inventory.clear();
      resourceResolver.invalidate();
      await pool.close();
      gateway.reconcile([]);
    },
  });
  const load = store.load,
    save = store.save;
  const connectionKey = (entry) =>
    JSON.stringify([
      entry.transport,
      entry.url,
      entry.command,
      entry.args,
      entry.env,
      entry.headers,
      entry.apiKey,
    ]);
  function makeClient(entry) {
    const client = new Client(
      { name: "workbuddy-local", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: async (error, tools) => {
              if (error || !Array.isArray(tools) || closed || !pool.owns(entry.id, client)) return;
              try {
                const entries = await load(),
                  current = entries.find((server) => server.id === entry.id);
                if (
                  closed ||
                  !current ||
                  current.disabled ||
                  connectionKey(current) !== connectionKey(entry) ||
                  !pool.owns(entry.id, client)
                )
                  return;
                inventory.set(entry.id, tools);
                getCatalog(entries);
              } catch {}
            },
          },
        },
      },
    );
    const transport = ["http", "sse"].includes(entry.transport)
      ? new (entry.transport === "sse" ? LegacySSETransport : StreamableHTTPClientTransport)(
          new URL(entry.url),
          {
            requestInit: {
              headers: {
                ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}),
                ...entry.headers,
              },
            },
          },
        )
      : new StdioClientTransport({
          command: entry.command,
          args: entry.args,
          env: {
            PATH: process.env.PATH || "",
            HOME: process.env.HOME || "",
            LANG: "en_US.UTF-8",
            ...entry.env,
          },
          stderr: "pipe",
        });
    return { client, transport };
  }
  const pool = createMcpPool({
    connect: async (id, signal) => {
      const entry = (await load()).find((server) => server.id === id);
      if (!entry || entry.disabled) throw Error("Connector unavailable");
      const { client, transport } = makeClient(entry),
        abort = () => client.close().catch(() => {});
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw Error("Connection cancelled");
        await client.connect(transport, { timeout: 15000 });
        transport.stderr?.resume();
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
  async function useServer(serverId, signal, operation, toolName, retain = false) {
    if (closed) throw Error("MCP runtime closed");
    const entry = (await load()).find((s) => s.id === serverId);
    if (!entry) throw new Error("连接器不存在；请先在连接器页面配置。");
    if (toolName && entry.disabledTools?.includes(toolName)) throw Error("MCP工具已停用。");
    if (entry.disabled === true) throw Error("连接器已停用，不能连接或调用工具。");
    if (retain || ["connecting", "connected"].includes(pool.state(serverId).status)) {
      if (signal?.aborted) throw Error("已取消。");
      const client = await pool.acquire(serverId, connectionKey(entry), signal);
      if (signal?.aborted) throw Error("已取消。");
      return operation(client, entry);
    }
    const { client, transport } = makeClient(entry);
    let retainClient = false,
      completed = false;
    const abort = () => {
      client.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("已取消。");
      await client.connect(transport, { timeout: 15_000 });
      if (transport.stderr) transport.stderr.resume();
      const result = await operation(client, entry, () => {
        retainClient = true;
      });
      completed = true;
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      let adopted = false;
      try {
        if (retainClient && completed && !closed && !signal?.aborted) {
          const current = (await load()).find((server) => server.id === serverId);
          if (
            current &&
            !current.disabled &&
            !current.disabledTools?.includes(toolName) &&
            connectionKey(current) === connectionKey(entry) &&
            !closed &&
            !signal?.aborted
          )
            adopted = await pool.adopt(serverId, connectionKey(entry), client);
        }
      } finally {
        if (!adopted) await client.close().catch(() => {});
      }
    }
  }
  const listTools = (serverId, signal, retain = false) =>
    useServer(
      serverId,
      signal,
      async (client, entry) => {
        const result = await collectMcpList(client, "listTools", "tools", { signal });
        inventory.set(serverId, result.tools);
        return {
          ...result,
          tools: result.tools.map((tool) => ({
            ...tool,
            enabled: !entry.disabledTools?.includes(tool.name),
          })),
        };
      },
      undefined,
      retain,
    );
  const getCatalog = (entries) => {
    const catalog = buildMcpAppCatalog(
      entries
        .filter((entry) => !entry.disabled && pool.state(entry.id).status === "connected")
        .map((entry) => ({
          configId: entry.id,
          tools: (inventory.get(entry.id) || []).filter(
            (tool) => !entry.disabledTools?.includes(tool.name),
          ),
        })),
    );
    gateway.reconcile(catalog);
    return catalog;
  };
  let hostServer, hostStarting;
  async function startHost() {
    if (closed) throw Error("MCP runtime closed");
    if (hostStarting) return hostStarting;
    hostStarting = (async () => {
      const sandboxHtml = await readFile(
        new URL("./mcp-app-sandbox.html", import.meta.url),
        "utf8",
      );
      if (closed) throw Error("MCP runtime closed");
      let liveCatalog = [];
      const handler = createMcpAppHttpHandler({
        sandboxHtml,
        getInstance: (id) => {
          const instance = gateway.get(id);
          return liveCatalog.some((app) => app.mcpAppId === instance.appId) ? instance : undefined;
        },
      });
      hostServer = http.createServer(async (req, res) => {
        try {
          liveCatalog = getCatalog(await load());
          if (!handler(req, res, new URL(req.url, "http://127.0.0.1"))) {
            res.writeHead(404);
            res.end();
          }
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end("MCP App host error");
        }
      });
      await new Promise((resolve, reject) => {
        hostServer.once("error", reject);
        hostServer.listen(0, "127.0.0.1", resolve);
      });
      return "http://127.0.0.1:" + hostServer.address().port;
    })();
    try {
      return await hostStarting;
    } catch (error) {
      hostStarting = undefined;
      throw error;
    }
  }
  const resourceResolver = createMcpAppResourceResolver((app) =>
    useServer(
      app.serverId,
      undefined,
      (client) => client.readResource({ uri: app.resourceUri }, { timeout: 15000 }),
      app.toolName,
    ),
  );
  const gateway = createMcpAppInstances({
    listApps: async () => getCatalog(await load()),
    resolveResource: (app) => resourceResolver.resolve(app),
    invalidateResource: (appId) => resourceResolver.invalidate(appId),
    callTool: (app, args) =>
      useServer(
        app.serverId,
        undefined,
        (client) => client.callTool({ name: app.toolName, arguments: args }, { timeout: 60000 }),
        app.toolName,
      ),
    createUrls: async (id) => {
      const origin = await startHost();
      return {
        appUrl: `${origin}/mcp-apps/${id}/app.html`,
        sandboxUrl: `${origin}/mcp-apps/sandbox-proxy.html`,
        preloadUrl: new URL("./mcp-app-preload.cjs", import.meta.url).href,
      };
    },
  });
  async function liveInstance(id) {
    const instance = gateway.get(id);
    if (!getCatalog(await load()).some((app) => app.mcpAppId === instance.appId))
      throw Error(`App definition for instance ${id} no longer exists`);
    return instance;
  }
  const tools = [
    {
      definition: {
        type: "function",
        function: {
          name: "connector_list",
          description:
            "List MCP connectors explicitly configured by the user, without connecting or launching programs.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      requiresApproval: false,
      handler: async () => (await load()).map(describeServer),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_list",
          description:
            "Connect to one user-configured MCP server and list its tools and input schemas. Stdio starts its configured local program. Requires approval.",
          parameters: {
            type: "object",
            properties: { serverId: { type: "string" } },
            required: ["serverId"],
            additionalProperties: false,
          },
        },
      },
      requiresApproval: true,
      handler: async ({ serverId }, { signal }) => {
        const result = await listTools(serverId, signal);
        return {
          tools: result.tools
            .filter((tool) => tool.enabled !== false)
            .map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
        };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "mcp_call",
          description:
            "Call a named tool on a user-configured MCP server using arguments from its advertised schema. Requires approval before sending arguments or launching the server.",
          parameters: {
            type: "object",
            properties: {
              serverId: { type: "string" },
              name: { type: "string" },
              arguments: { type: "object" },
            },
            required: ["serverId", "name", "arguments"],
            additionalProperties: false,
          },
        },
      },
      requiresApproval: true,
      handler: async ({ serverId, name, arguments: args }, { signal }) =>
        useServer(
          serverId,
          signal,
          async (client, entry, keepClient) => {
            const { tools: available } = await collectMcpList(client, "listTools", "tools", {
              signal,
            });
            if (!available.some((t) => t.name === name)) throw new Error("该服务器未声明此工具。");
            const result = await client.callTool(
              { name, arguments: args },
              { timeout: 60_000, signal },
            );
            if (extractToolUiMetadata(available.find((tool) => tool.name === name))?.resourceUri) {
              inventory.set(serverId, available);
              keepClient?.();
            }
            return result;
          },
          name,
        ),
    },
  ];
  const handleRoute = async (req, res, url, { body }) => {
    if (!url.pathname.startsWith("/api/connectors")) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[1] !== "connectors") return false;
    const id = segments[2];
    try {
      const entries = await load();
      if (id === "apps" && req.method === "GET") {
        send(res, 200, getCatalog(entries));
        return true;
      }
      if (id === "apps" && req.method === "POST") {
        const action = segments[3];
        if (action === "notify-agent") {
          getCatalog(entries);
          send(res, 200, await gateway.notifyAgent(body));
          return true;
        }
        if (action === "push-result") {
          getCatalog(entries);
          send(res, 200, {
            handled: gateway.push(
              {
                toolCallId: body.toolCallId,
                sessionId: body.sessionId,
                appInstanceId: body.appInstanceId,
              },
              body.result && typeof body.result === "object" ? body.result : {},
            ),
          });
          return true;
        }
        if (action === "record-context" || action === "get-context") {
          getCatalog(entries);
          send(
            res,
            200,
            action === "record-context"
              ? { handled: gateway.recordContext(body.appInstanceId, body.update) }
              : (gateway.getContext(body.appInstanceId) ?? null),
          );
          return true;
        }
        if (action === "open") send(res, 200, await gateway.open(body));
        else if (action === "close") {
          gateway.close(body.appInstanceId);
          send(res, 200, { ok: true });
        } else if (action === "resolve") {
          const app = getCatalog(entries).find((entry) => entry.mcpAppId === body.appId);
          if (!app) throw Error("Unknown MCP App: provide a valid appId");
          const resource = await useServer(
            app.serverId,
            undefined,
            (client) => client.readResource({ uri: app.resourceUri }, { timeout: 15000 }),
            app.toolName,
          );
          send(res, 200, resolveMcpAppResource(resource, app.resourceUri));
        } else {
          const instance = await liveInstance(body.appInstanceId);
          if (action === "view") send(res, 200, gateway.view(body.appInstanceId));
          else if (action === "refresh")
            send(
              res,
              200,
              await gateway.refresh(
                body.appInstanceId,
                body.toolInput && typeof body.toolInput === "object" ? body.toolInput : undefined,
              ),
            );
          else if (["tools", "resources", "templates", "prompts"].includes(action)) {
            send(
              res,
              200,
              await useServer(
                instance.serverId,
                undefined,
                (client) => {
                  const capabilities = client.getServerCapabilities() || {};
                  if (action === "tools") return collectMcpList(client, "listTools", "tools");
                  if (action === "resources")
                    return capabilities.resources
                      ? collectMcpList(client, "listResources", "resources")
                      : { resources: [] };
                  if (action === "templates")
                    return capabilities.resources
                      ? collectMcpList(client, "listResourceTemplates", "resourceTemplates")
                      : { resourceTemplates: [] };
                  return capabilities.prompts
                    ? collectMcpList(client, "listPrompts", "prompts")
                    : { prompts: [] };
                },
                instance.toolName,
              ),
            );
          } else if (action === "await")
            send(res, 200, (await gateway.awaitBootstrap(body.appInstanceId)) ?? null);
          else if (action === "read") {
            if (typeof body.uri !== "string" || !body.uri) throw Error("uri required");
            send(
              res,
              200,
              await useServer(
                instance.serverId,
                undefined,
                (client) => client.readResource({ uri: body.uri }, { timeout: 15000 }),
                instance.toolName,
              ),
            );
          } else if (action === "call") {
            if (typeof body.toolName !== "string" || !body.toolName)
              throw Error("toolName required");
            send(
              res,
              200,
              await useServer(
                instance.serverId,
                undefined,
                async (client) => {
                  const available = await collectMcpList(client, "listTools", "tools");
                  if (!available.tools.some((tool) => tool.name === body.toolName))
                    throw Error("MCP server does not declare this tool");
                  return client.callTool(
                    {
                      name: body.toolName,
                      arguments:
                        body.arguments && typeof body.arguments === "object" ? body.arguments : {},
                    },
                    { timeout: 60000 },
                  );
                },
                body.toolName,
              ),
            );
          } else throw Error("Unsupported MCP App action");
        }
        return true;
      }
      if (req.method === "GET" && id === "config") {
        send(res, 200, await store.getDocument());
        return true;
      }
      if (req.method === "PUT" && id === "config") {
        if (!Array.isArray(body.entries))
          throw Error("Connector configuration requires entries array");
        const next = body.entries.map((input) => {
          const previous = entries.find((entry) => entry.name === input?.name);
          return validate({ ...previous, ...input, id: previous?.id || randomUUID() });
        });
        if (new Set(next.map((entry) => entry.name)).size !== next.length)
          throw Error("Duplicate connector names");
        await save(next);
        inventory.clear();
        resourceResolver.invalidate();
        await pool.close();
        getCatalog(next);
        send(res, 200, { success: true });
        return true;
      }
      if (req.method === "GET" && !id) {
        send(res, 200, entries.map(describeServer));
        return true;
      }
      if (segments[3] === "resources" && req.method === "GET") {
        const result = await useServer(id, undefined, (client) =>
          collectMcpList(client, "listResources", "resources"),
        );
        send(res, 200, result);
        return true;
      }
      if (segments[3] === "resources" && req.method === "POST") {
        if (typeof body.uri !== "string" || !body.uri.trim()) throw Error("Resource URI required");
        const result = await useServer(id, undefined, (client) =>
          client.readResource({ uri: body.uri }, { timeout: 15000 }),
        );
        send(res, 200, result);
        return true;
      }
      if (req.method === "POST" && segments[3] === "connect") {
        const result = await listTools(id, undefined, true);
        send(res, 200, {
          tools: result.tools.map(({ name, description, enabled }) => ({
            name,
            description,
            enabled,
          })),
        });
        return true;
      }
      if (req.method === "POST" && !id) {
        const server = validate({ ...body, id: randomUUID() });
        entries.push(server);
        await save(entries);
        send(res, 201, describeServer(server));
        return true;
      }
      const index = entries.findIndex((s) => s.id === id);
      if (index < 0) {
        send(res, 404, { error: "连接器不存在。" });
        return true;
      }
      if (req.method === "PUT") {
        // Omitted secrets keep their existing values; explicit empty values clear them.
        const connectionKey = (entry) =>
          JSON.stringify([
            entry.transport,
            entry.url,
            entry.command,
            entry.args,
            entry.env,
            entry.headers,
            entry.apiKey,
          ]);
        const previousKey = connectionKey(entries[index]);
        entries[index] = validate({ ...entries[index], ...body, id });
        if (previousKey !== connectionKey(entries[index]) || entries[index].disabled) {
          inventory.delete(id);
          resourceResolver.invalidate();
          await pool.invalidate(id);
        }

        await save(entries);
        getCatalog(entries);
        send(res, 200, describeServer(entries[index]));
        return true;
      }
      if (req.method === "DELETE") {
        await save(entries.filter((s) => s.id !== id));
        inventory.delete(id);
        resourceResolver.invalidate();
        await pool.invalidate(id);
        getCatalog(entries.filter((entry) => entry.id !== id));
        send(res, 200, { ok: true });
        return true;
      }
      send(res, 405, { error: "不支持此操作。" });
      return true;
    } catch (error) {
      send(res, 400, { error: error.message });
      return true;
    }
  };
  let mutations = Promise.resolve();
  const routes = (...args) => {
    const [req, , url] = args;
    if (!url.pathname.startsWith("/api/connectors")) return handleRoute(...args);
    if (req.method === "GET" || url.pathname.endsWith("/connect"))
      return mutations.then(() => handleRoute(...args));
    const operation = mutations.then(() => handleRoute(...args));
    mutations = operation.catch(() => {});
    return operation;
  };
  return {
    tools,
    routes,
    close: () => {
      if (closing) return closing;
      closed = true;
      gateway.dispose();
      closing = (async () => {
        await pool.close();
        await hostStarting?.catch(() => {});
        if (hostServer?.listening) {
          hostServer.closeAllConnections();
          await new Promise((resolve) => hostServer.close(resolve));
        }
      })();
      return closing;
    },
  };
}
