import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { extractToolUiMetadata, buildMcpAppCatalog } from "./mcp-app-catalog.mjs";

test("MCP UI metadata matches shipped extractor across legacy, malformed and visibility cases", async () => {
  const source = await fs.readFile(
    new URL("../../workbuddy-analysis/extracted/main/initialize.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function extractToolUiMetadata(tool) {"),
    end = source.indexOf("function normalizeServerId", start);
  assert(start >= 0 && end > start);
  const original = vm.runInNewContext(
    source.slice(start, end) + "\nextractToolUiMetadata",
    {},
    { timeout: 1000 },
  );
  for (const meta of [
    undefined,
    null,
    "bad",
    {},
    { ui: { resourceUri: "ui://view", visibility: ["app", "bad", "model"] } },
    { ui: { resourceUri: "", visibility: [] }, "ui/resourceUri": "ui://legacy" },
    { "ui/resourceUri": "ui://legacy" },
    { ui: { resourceUri: 3 } },
    { ui: { resourceUri: "ui://view", visibility: [] } },
  ]) {
    const tool = { name: "proof", _meta: meta };
    assert.equal(JSON.stringify(extractToolUiMetadata(tool)), JSON.stringify(original(tool)));
  }
});

test("catalog preserves original tool routing, metadata and default visibility", () => {
  const meta = { ui: { resourceUri: "ui://proof", visibility: ["invalid"] } };
  const apps = buildMcpAppCatalog([
    {
      configId: "user:connector",
      tools: [
        {
          name: "prefix_proof",
          originalName: "proof",
          description: "Proof",
          _meta: meta,
          inputSchema: { type: "object" },
        },
        { name: "ordinary" },
      ],
    },
  ]);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].mcpAppId, "connector/proof");
  assert.equal(apps[0].prefixedToolName, "prefix_proof");
  assert.equal(apps[0].toolName, "proof");
  assert.equal(apps[0].toolMeta, meta);
  assert.deepEqual(apps[0].visibility, ["model", "app"]);
});

test("MCP App resource selection matches shipped text, blob, MIME and metadata behavior", async () => {
  const { resolveMcpAppResource } = await import("./mcp-app-resource.mjs");
  const source = await fs.readFile(
    new URL("../../workbuddy-analysis/extracted/main/initialize.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function pickHtmlContent(contents) {"),
    end = source.indexOf("var AppResolver = class", start);
  assert(start >= 0 && end > start);
  const original = vm.runInNewContext(
    source.slice(start, end) + "\n({pickHtmlContent,extractResourceUiMetadata})",
    { Buffer },
    { timeout: 1000 },
  );
  for (const contents of [
    [{ text: "<p>中文</p>" }],
    [
      {
        blob: Buffer.from("<p>Base64中文</p>").toString("base64"),
        _meta: { ui: { prefersBorder: true } },
      },
    ],
    [
      { text: "FIRST", mimeType: "text/plain" },
      { text: "SECOND", _meta: { ui: { csp: { connectDomains: [] } } } },
    ],
    [{ text: "", blob: Buffer.from("FALLBACK").toString("base64") }],
  ]) {
    const selected = original.pickHtmlContent(contents);
    const expected = { ...selected, uiMetadata: original.extractResourceUiMetadata(contents) };
    assert.equal(
      JSON.stringify(resolveMcpAppResource({ contents }, "ui://proof")),
      JSON.stringify(expected),
    );
  }
  assert.throws(
    () => resolveMcpAppResource({ contents: [] }, "ui://empty"),
    /contains no readable HTML body/,
  );
});
