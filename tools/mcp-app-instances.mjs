import { randomUUID } from "node:crypto";

function defaults(schema) {
  if (!schema || typeof schema !== "object") return {};
  let properties = schema.properties;
  if (!properties || typeof properties !== "object") {
    const match =
      typeof schema.$ref === "string" && /^#\/(definitions|\$defs)\/([^/]+)$/.exec(schema.$ref);
    properties = match && schema[match[1]]?.[match[2]]?.properties;
  }
  return Object.fromEntries(
    Object.entries(properties || {})
      .filter(([, value]) => value && typeof value === "object" && "default" in value)
      .map(([key, value]) => [key, value.default]),
  );
}

/** Instance lifecycle; HTTP host and guest bridge are supplied by the desktop runtime. */
export function createMcpAppInstances({
  listApps,
  resolveResource,
  callTool,
  createUrls,
  invalidateResource = () => {},
}) {
  let disposed = false;
  const ensureOpen = () => {
    if (disposed) throw Error("MCP App gateway closed");
  };
  const instances = new Map(),
    index = new Map(),
    pending = new Map(),
    buffered = new Map();
  function findPushInstance(params) {
    if (params.appInstanceId) return instances.get(params.appInstanceId);
    const exact = instances.get(index.get(keyFor(params)));
    if (exact) return exact;
    let unsettled, settled;
    for (const instance of instances.values()) {
      if (!params.toolCallId || instance.toolCallId !== params.toolCallId) continue;
      if (params.sessionId && instance.sessionId && params.sessionId !== instance.sessionId)
        continue;
      if (instance.toolResultResolver) unsettled = instance;
      else settled = instance;
    }
    return unsettled || settled;
  }
  function push(params, result) {
    if (disposed) return false;
    const instance = findPushInstance(params);
    if (!instance) {
      const key = keyFor(params);
      if (key) {
        if (buffered.size >= 256) buffered.delete(buffered.keys().next().value);
        buffered.set(key, result);
      }
      return false;
    }
    if (instance.settled || !instance.toolResultResolver) return false;
    instance.settled = true;
    instance.toolResultResolver(result);
    instance.toolResultResolver = undefined;
    instance.toolResult = result;
    return true;
  }
  const keyFor = (params) =>
    params.toolCallId
      ? params.sessionId
        ? `${params.sessionId}::${params.toolCallId}`
        : params.toolCallId
      : undefined;
  function requireInstance(id) {
    const instance = instances.get(id);
    if (!instance) throw Error(`Unknown MCP App instance: ${id}`);
    return instance;
  }
  function descriptor(instance) {
    const {
      appInstanceId,
      appId,
      appUrl,
      sandboxUrl,
      preloadUrl,
      uiMetadata,
      toolMeta,
      toolInput,
      mcpAppName,
    } = instance;
    return {
      appInstanceId,
      appId,
      mcpAppName,
      appUrl,
      sandboxUrl,
      preloadUrl,
      uiMetadata,
      toolMeta,
      toolInput,
      toolResult: undefined,
    };
  }
  async function create(params, key) {
    ensureOpen();
    const apps = await listApps();
    ensureOpen();
    const app = params.appId
      ? apps.find((item) => item.mcpAppId === params.appId)
      : apps.find((item) => item.prefixedToolName === params.prefixedToolName);
    if (!app) throw Error("Unknown MCP App: provide a valid appId or prefixedToolName");
    const toolInput = { ...defaults(app.inputSchema), ...params.toolInput };
    let toolResultPromise, toolResultResolver;
    if (params.bootstrapToolCall !== false) {
      toolResultPromise = Promise.resolve()
        .then(() => callTool(app, toolInput, params.sessionId))
        .catch((error) => ({
          content: [{ type: "text", text: `MCP Apps initial tool call error: ${error.message}` }],
          isError: true,
        }));
    } else if (params.toolCallId)
      toolResultPromise = new Promise((resolve) => {
        toolResultResolver = resolve;
      });
    const resolved = await resolveResource(app),
      appInstanceId = randomUUID();
    ensureOpen();
    const stillDeclared = async () => {
      const live = await listApps();
      ensureOpen();
      if (!live.some((item) => item.mcpAppId === app.mcpAppId))
        throw Error(`MCP App definition no longer exists: ${app.mcpAppId}`);
    };
    await stillDeclared();
    const urls = await createUrls(appInstanceId, resolved);
    ensureOpen();
    await stillDeclared();
    const instance = {
      appInstanceId,
      appId: app.mcpAppId,
      mcpAppName: app.mcpAppName,
      serverId: app.serverId,
      resourceUri: app.resourceUri,
      toolName: app.toolName,
      prefixedToolName: app.prefixedToolName,
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      ...urls,
      uiMetadata: resolved.uiMetadata,
      toolMeta: app.toolMeta,
      toolInput,
      toolResult: undefined,
      createdAt: Date.now(),
      html: resolved.html,
      toolResultPromise,
      toolResultResolver,
      settled: false,
    };
    instances.set(appInstanceId, instance);
    if (key) index.set(key, appInstanceId);
    if (params.bootstrapToolCall === false && key) {
      const bufferedKey = buffered.has(key) ? key : params.toolCallId;
      if (buffered.has(bufferedKey)) {
        const result = buffered.get(bufferedKey);
        buffered.delete(key);
        buffered.delete(params.toolCallId);
        push(params, result);
      }
    }
    toolResultPromise?.then((result) => {
      if (instances.get(appInstanceId) === instance) {
        instance.toolResult = result;
        instance.settled = true;
      }
    });
    return descriptor(instance);
  }
  return {
    async notifyAgent(params = {}) {
      if (!params.toolCallId || !params.prefixedToolName) return { handled: false };
      const apps = await listApps();
      const matches = apps.filter(
        (app) =>
          app.prefixedToolName === params.prefixedToolName &&
          (!params.serverId || app.serverId === params.serverId),
      );
      if (matches.length !== 1) return { handled: false };
      const descriptor = await this.open({
        appId: matches[0].mcpAppId,
        sessionId: params.sessionId,
        toolCallId: params.toolCallId,
        toolInput: params.rawInput,
        bootstrapToolCall: false,
      });
      const instance = requireInstance(descriptor.appInstanceId);
      if (params.conversationRequestId)
        instance.conversationRequestId = params.conversationRequestId;
      return { handled: true, appInstanceId: descriptor.appInstanceId, descriptor };
    },
    open(params = {}) {
      if (disposed) return Promise.reject(Error("MCP App gateway closed"));
      const key = keyFor(params),
        existing = key && instances.get(index.get(key));
      if (existing) return Promise.resolve(descriptor(existing));
      if (key && pending.has(key)) return pending.get(key);
      const task = create(params, key).finally(() => {
        if (key && pending.get(key) === task) pending.delete(key);
      });
      if (key) pending.set(key, task);
      return task;
    },
    get: requireInstance,
    recordContext(id, update) {
      const instance = instances.get(id);
      if (!instance) return false;
      const typed = update && typeof update === "object" ? update : {};
      const content = Array.isArray(typed.content)
        ? typed.content.filter((entry) => entry && typeof entry === "object")
        : undefined;
      const structuredContent =
        typed.structuredContent &&
        typeof typed.structuredContent === "object" &&
        !Array.isArray(typed.structuredContent)
          ? typed.structuredContent
          : undefined;
      instance.lastModelContextUpdate = {
        timestamp: Date.now(),
        ...(content ? { content } : {}),
        ...(structuredContent ? { structuredContent } : {}),
      };
      return true;
    },
    getContext(id) {
      return instances.get(id)?.lastModelContextUpdate;
    },
    view(id) {
      const instance = requireInstance(id);
      return {
        resourceUri: instance.resourceUri,
        html: instance.html,
        uiMetadata: instance.uiMetadata,
      };
    },
    awaitBootstrap(id) {
      return requireInstance(id).toolResultPromise;
    },
    async refresh(id, toolInput) {
      const instance = requireInstance(id),
        apps = await listApps();
      const app = apps.find((item) => item.mcpAppId === instance.appId);
      if (!app) throw Error(`App definition for instance ${id} no longer exists`);
      const input = toolInput ?? instance.toolInput;
      const result = await callTool(app, input, instance.sessionId);
      if (instances.get(id) === instance) {
        instance.toolInput = input;
        instance.toolResult = result;
      }
      return result;
    },
    push,
    close(id) {
      const instance = instances.get(id);
      if (!instance) return;
      invalidateResource(instance.appId);
      instances.delete(id);
      const key = keyFor(instance);
      if (key && index.get(key) === id) index.delete(key);
    },
    dispose() {
      disposed = true;
      invalidateResource();
      for (const instance of instances.values())
        instance.toolResultResolver?.({
          content: [{ type: "text", text: "MCP App gateway closed" }],
          isError: true,
        });
      instances.clear();
      index.clear();
      pending.clear();
      buffered.clear();
    },
    reconcile(apps) {
      const live = new Set(apps.map((app) => app.mcpAppId));
      for (const [id, instance] of instances) {
        if (live.has(instance.appId)) continue;
        invalidateResource(instance.appId);
        instance.toolResultResolver?.({
          content: [{ type: "text", text: "MCP App definition no longer exists" }],
          isError: true,
        });
        instances.delete(id);
        const key = keyFor(instance);
        if (key && index.get(key) === id) index.delete(key);
      }
    },
  };
}
