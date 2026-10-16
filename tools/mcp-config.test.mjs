import test from "node:test";
import assert from "node:assert/strict";
import { formatMcpConfig, parseMcpConfig } from "./mcp-config.mjs";
test("user MCP JSON roundtrip retains real IDs local secrets transport and tool state", () => {
  const entries = [
    {
      id: "stdio-id",
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "fixture-token" },
      disabled: false,
      disabledTools: ["hidden"],
    },
    {
      id: "sse-id",
      name: "remote",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: "fixture-header" },
      apiKey: "fixture-key",
      disabled: true,
      disabledTools: [],
    },
  ];
  const text = formatMcpConfig(entries);
  assert.equal(Array.isArray(JSON.parse(text)), false);
  assert.equal(JSON.parse(text).mcpServers.remote.type, "sse");
  assert.deepEqual(parseMcpConfig(text, entries), entries);
  const edited = JSON.parse(text);
  delete edited.mcpServers.remote.apiKey;
  delete edited.mcpServers.local.env;
  const parsed = parseMcpConfig(JSON.stringify(edited), entries);
  assert.equal(parsed[1].apiKey, "fixture-key");
  assert.equal(parsed[0].env.TOKEN, "fixture-token");
});
test("invalid user config rejects before modifying previous entries", () => {
  const previous = [
      {
        id: "id",
        name: "local",
        transport: "http",
        url: "https://example.test/mcp",
        apiKey: "fixture",
      },
    ],
    snapshot = JSON.stringify(previous);
  for (const content of [
    "{",
    JSON.stringify({ mcpServers: [] }),
    JSON.stringify({ mcpServers: { local: { url: "invalid" } } }),
    JSON.stringify({ mcpServers: { local: { url: "https://example.test", disabled: "yes" } } }),
  ])
    assert.throws(() => parseMcpConfig(content, previous));
  assert.equal(JSON.stringify(previous), snapshot);
});
