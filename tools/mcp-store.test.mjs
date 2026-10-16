import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpStore } from "./mcp-store.mjs";
test("user MCP file loads valid external edits with stable IDs and preserves invalid text and last usable configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-user-store-")),
    store = createMcpStore(dir);
  await store.save([
    {
      id: "stable",
      name: "proof",
      transport: "http",
      url: "https://example.test/mcp",
      apiKey: "fixture-key",
      disabled: false,
      disabledTools: [],
    },
  ]);
  const document = await store.getDocument();
  assert.equal(document.filePath, join(dir, "mcp.json"));
  const config = JSON.parse(document.content);
  config.mcpServers.proof.url = "https://example.test/changed";
  delete config.mcpServers.proof.apiKey;
  await writeFile(document.filePath, JSON.stringify(config));
  const changed = await store.load();
  assert.equal(changed[0].id, "stable");
  assert.equal(changed[0].apiKey, "fixture-key");
  assert.equal(changed[0].url, "https://example.test/changed");
  await writeFile(document.filePath, "{ invalid");
  assert.deepEqual(await store.load(), changed);
  const invalid = await store.getDocument();
  assert.equal(invalid.content, "{ invalid");
  assert(invalid.validationError);
  await writeFile(document.filePath, JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(await store.load(), []);
});
test("failed user document save restores internal configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-user-rollback-"));
  const original = "[]";
  await writeFile(join(dir, "connectors.json"), original);
  await mkdir(join(dir, "mcp.json"));
  const store = createMcpStore(dir);
  await assert.rejects(
    store.save([{ id: "new", name: "proof", transport: "http", url: "https://example.test/mcp" }]),
  );
  assert.equal(await readFile(join(dir, "connectors.json"), "utf8"), original);
});
