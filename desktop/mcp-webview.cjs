const { pathToFileURL } = require("node:url");
function createMcpWebviewPolicy(preloadPath) {
  const preloadUrl = pathToFileURL(preloadPath).href,
    instances = new Map();
  const loopback = (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password
      );
    } catch {
      return false;
    }
  };
  return {
    register(descriptor) {
      if (
        !descriptor ||
        descriptor.preloadUrl !== preloadUrl ||
        !loopback(descriptor.appUrl) ||
        !loopback(descriptor.sandboxUrl)
      )
        throw Error("Invalid MCP webview descriptor");
      const app = new URL(descriptor.appUrl),
        sandbox = new URL(descriptor.sandboxUrl);
      if (
        app.origin !== sandbox.origin ||
        app.pathname !== `/mcp-apps/${descriptor.appInstanceId}/app.html` ||
        sandbox.pathname !== "/mcp-apps/sandbox-proxy.html"
      )
        throw Error("Invalid MCP webview route");
      const added = !instances.has(descriptor.appInstanceId);
      instances.set(descriptor.appInstanceId, descriptor);
      return added;
    },
    remove(id) {
      instances.delete(id);
    },
    reconcile(apps) {
      const live = new Set(apps.map((app) => app.mcpAppId));
      for (const [id, descriptor] of instances)
        if (!live.has(descriptor.appId)) instances.delete(id);
    },
    allowsURL(value) {
      return [...instances.values()].some(
        (entry) => value === entry.appUrl || value === entry.sandboxUrl,
      );
    },
    attach(event, preferences, params) {
      if (
        !this.allowsURL(params.src) ||
        params.partition !== "persist:mcp-apps" ||
        (params.preload && params.preload !== preloadUrl && params.preload !== preloadPath)
      ) {
        event.preventDefault();
        return false;
      }
      Object.assign(preferences, {
        preload: preloadPath,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: false,
        sandbox: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        enableRemoteModule: false,
      });
      return true;
    },
  };
}
module.exports = { createMcpWebviewPolicy };
