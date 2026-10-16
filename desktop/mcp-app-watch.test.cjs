const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcpAppWatch } = require("./mcp-app-watch.cjs");
const { createMcpWebviewPolicy } = require("./mcp-webview.cjs");
const { pathToFileURL } = require("node:url");

test("MCP Apps watcher publishes changed metadata only and removes stale webview registrations", async () => {
  const preload = "/tmp/wb/mcp-app-preload.cjs",
    policy = createMcpWebviewPolicy(preload),
    published = [];
  let apps = [],
    stopped = false;
  const watcher = createMcpAppWatch({
    getApps: async () => apps,
    publish: (snapshot) => {
      policy.reconcile(snapshot);
      published.push(snapshot);
    },
    schedule: () => ({}),
    unschedule: () => {
      stopped = true;
    },
  });
  watcher.start();
  await new Promise(setImmediate);
  apps = [{ mcpAppId: "server/proof", resourceUri: "ui://proof" }];
  await watcher.tick();
  const descriptor = {
    appInstanceId: "proof",
    appId: "server/proof",
    appUrl: "http://127.0.0.1:18799/mcp-apps/proof/app.html",
    sandboxUrl: "http://127.0.0.1:18799/mcp-apps/sandbox-proxy.html",
    preloadUrl: pathToFileURL(preload).href,
  };
  policy.register(descriptor);
  await watcher.tick();
  assert.equal(published.length, 2);
  assert.equal(policy.allowsURL(descriptor.appUrl), true);
  apps = [{ ...apps[0], resourceUri: "ui://changed" }];
  await watcher.tick();
  assert.equal(published.length, 3);
  assert.equal(policy.allowsURL(descriptor.appUrl), true);
  apps = [];
  await watcher.tick();
  assert.equal(published.length, 4);
  assert.equal(policy.allowsURL(descriptor.appUrl), false);
  watcher.stop();
  apps = [{ mcpAppId: "server/late" }];
  await watcher.tick();
  assert.equal(published.length, 4);
  assert.equal(stopped, true);
});
