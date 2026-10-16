import test from "node:test";
import assert from "node:assert/strict";
import { createMcpAppResourceResolver } from "./mcp-app-resource.mjs";

test("MCP App resource cache reuses URI and invalidates per app", async () => {
  let reads = 0;
  const resolver = createMcpAppResourceResolver(async () => ({
    contents: [{ text: "HTML-" + ++reads }],
  }));
  const app = { mcpAppId: "server/view", resourceUri: "ui://view" };
  assert.equal((await resolver.resolve(app)).html, "HTML-1");
  assert.equal((await resolver.resolve(app)).html, "HTML-1");
  assert.equal(reads, 1);
  assert.equal((await resolver.resolve({ ...app, resourceUri: "ui://other" })).html, "HTML-2");
  resolver.invalidate(app.mcpAppId);
  assert.equal((await resolver.resolve(app)).html, "HTML-3");
  assert.equal((await resolver.resolve(app, { bypassCache: true })).html, "HTML-4");
});

test("MCP resource completing after invalidation cannot repopulate cached HTML", async () => {
  let release,
    reads = 0;
  const resolver = createMcpAppResourceResolver(() => {
    reads++;
    return reads === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : { contents: [{ text: "FRESH" }] };
  });
  const app = { mcpAppId: "server/view", resourceUri: "ui://view" },
    old = resolver.resolve(app);
  resolver.invalidate();
  release({ contents: [{ text: "OLD" }] });
  assert.equal((await old).html, "OLD");
  assert.equal((await resolver.resolve(app)).html, "FRESH");
  assert.equal(reads, 2);
});
