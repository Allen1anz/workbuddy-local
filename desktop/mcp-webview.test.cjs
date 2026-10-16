const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { createMcpWebviewPolicy } = require("./mcp-webview.cjs");

test("MCP webview policy permits registered app and pins preload and guest preferences", () => {
  const preload = "/tmp/workbuddy/tools/mcp-app-preload.cjs",
    policy = createMcpWebviewPolicy(preload);
  const descriptor = {
    appInstanceId: "proof",
    appUrl: "http://127.0.0.1:18799/mcp-apps/proof/app.html",
    sandboxUrl: "http://127.0.0.1:18799/mcp-apps/sandbox-proxy.html",
    preloadUrl: pathToFileURL(preload).href,
  };
  assert.equal(policy.register(descriptor), true);
  assert.equal(policy.register(descriptor), false);
  let prevented = false;
  const event = {
      preventDefault() {
        prevented = true;
      },
    },
    preferences = { nodeIntegration: true, webSecurity: false };
  assert.equal(
    policy.attach(event, preferences, {
      src: descriptor.appUrl,
      partition: "persist:mcp-apps",
      preload: descriptor.preloadUrl,
    }),
    true,
  );
  assert.equal(prevented, false);
  assert.equal(preferences.preload, preload);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.webSecurity, true);
  policy.remove("proof");
  assert.equal(
    policy.attach(event, {}, { src: descriptor.appUrl, partition: "persist:mcp-apps" }),
    false,
  );
  assert.equal(prevented, true);
});

test("MCP webview policy rejects arbitrary page, preload, partition and forged descriptor", () => {
  const preload = "/tmp/workbuddy/tools/mcp-app-preload.cjs",
    policy = createMcpWebviewPolicy(preload);
  const descriptor = {
    appInstanceId: "proof",
    appUrl: "http://127.0.0.1:18799/mcp-apps/proof/app.html",
    sandboxUrl: "http://127.0.0.1:18799/mcp-apps/sandbox-proxy.html",
    preloadUrl: pathToFileURL(preload).href,
  };
  policy.register(descriptor);
  for (const params of [
    { src: "https://example.com", partition: "persist:mcp-apps" },
    { src: "http://127.0.0.1:18799/api/sessions", partition: "persist:mcp-apps" },
    { src: descriptor.appUrl, partition: "other" },
    { src: descriptor.appUrl, partition: "persist:mcp-apps", preload: "file:///tmp/other.cjs" },
  ]) {
    let prevented = false;
    assert.equal(
      policy.attach(
        {
          preventDefault() {
            prevented = true;
          },
        },
        {},
        params,
      ),
      false,
    );
    assert.equal(prevented, true);
  }
  assert.throws(
    () => policy.register({ ...descriptor, appUrl: "https://example.com/mcp-apps/proof/app.html" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      policy.register({
        ...descriptor,
        sandboxUrl: "http://127.0.0.1:18800/mcp-apps/sandbox-proxy.html",
      }),
    /Invalid/,
  );
});
