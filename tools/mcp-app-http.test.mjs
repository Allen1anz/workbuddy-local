import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import vm from "node:vm";
import { buildMcpAppCsp, createMcpAppHttpHandler } from "./mcp-app-http.mjs";

test("MCP App CSP matches shipped host and rejects directive injection", async () => {
  const source = await fs.readFile(
    new URL("../../workbuddy-analysis/extracted/main/initialize.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function sanitizeCspDomains(domains) {"),
    end = source.indexOf("function extractInstanceIdFromPath", start);
  const original = vm.runInNewContext(
    source.slice(start, end) + "\nbuildCsp",
    {},
    { timeout: 1000 },
  );
  for (const ui of [
    undefined,
    {},
    {
      csp: {
        resourceDomains: ["https://cdn.example", "https://bad; connect-src *"],
        connectDomains: ["https://api.example"],
        frameDomains: ["https://embed.example"],
        baseUriDomains: ["https://base.example"],
      },
    },
  ])
    assert.equal(buildMcpAppCsp(ui), original(ui));
  assert(
    !buildMcpAppCsp({ csp: { connectDomains: ["https://bad; script-src *"] } }).includes(
      "https://bad",
    ),
  );
});

test("MCP App HTTP serves live instance and sandbox assets and rejects closed or malformed requests", async () => {
  const sandboxHtml = await fs.readFile(new URL("./mcp-app-sandbox.html", import.meta.url), "utf8");
  let instance = {
    html: "<html>真实实例</html>",
    uiMetadata: { csp: { connectDomains: ["https://api.example"] } },
  };
  const handler = createMcpAppHttpHandler({
    getInstance: (id) => (id === "proof" ? instance : undefined),
    sandboxHtml,
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res, new URL(req.url, "http://localhost"))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const response = await fetch(base + "/mcp-apps/proof/app.html");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), instance.html);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert(
      response.headers
        .get("content-security-policy")
        .includes("connect-src 'self' https://api.example"),
    );
    assert(response.headers.get("cache-control").includes("no-store"));
    const sandbox = await fetch(base + "/mcp-apps/sandbox-proxy.html");
    assert.equal(await sandbox.text(), sandboxHtml);
    assert(sandboxHtml.includes("ui/notifications/sandbox-proxy-ready"));
    assert.equal((await fetch(base + "/mcp-apps/sandbox-proxy.html?csp=%7B")).status, 400);
    assert.equal((await fetch(base + "/mcp-apps/proof/app.html", { method: "POST" })).status, 405);
    instance = undefined;
    assert.equal((await fetch(base + "/mcp-apps/proof/app.html")).status, 404);
    assert.equal((await fetch(base + "/mcp-apps/missing/app.html")).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
