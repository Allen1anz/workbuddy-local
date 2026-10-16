import test from "node:test";
test("MCP pool adopts live client without reconnecting or replacing another live client", async () => {
  let connects = 0,
    closes = 0;
  const client = {
      async close() {
        closes++;
        this.onclose?.();
      },
    },
    other = { async close() {} };
  const pool = createMcpPool({
    connect: async () => {
      connects++;
      return other;
    },
  });
  assert.equal(await pool.adopt("server", "config", client), true);
  assert.equal(pool.owns("server", client), true);
  assert.equal(pool.owns("server", other), false);
  assert.equal(await pool.acquire("server", "config"), client);
  assert.equal(connects, 0);
  assert.equal(await pool.adopt("server", "config", other), false);
  assert.equal(pool.state("server").status, "connected");
  await pool.close();
  assert.equal(pool.owns("server", client), false);
  assert.equal(closes, 1);
});
import assert from "node:assert/strict";
import { createMcpPool } from "./mcp-pool.mjs";
test("MCP pool shares concurrent acquisition and closes replaced and shutdown clients", async () => {
  let connections = 0,
    closed = 0;
  const pool = createMcpPool({
    connect: async () => {
      connections++;
      return {
        close: async function () {
          closed++;
          this.onclose?.();
        },
      };
    },
  });
  const [a, b] = await Promise.all([pool.acquire("proof", "one"), pool.acquire("proof", "one")]);
  assert.equal(a, b);
  assert.equal(connections, 1);
  assert.equal(pool.state("proof").status, "connected");
  const next = await pool.acquire("proof", "two");
  assert.notEqual(a, next);
  assert.equal(closed, 1);
  assert.equal(connections, 2);
  await pool.close();
  assert.equal(closed, 2);
  assert.equal(pool.state("proof").status, "disconnected");
});
test("late connecting client is closed after invalidation rather than retained", async () => {
  let ready,
    closed = 0;
  const pending = new Promise((resolve) => (ready = resolve)),
    pool = createMcpPool({ connect: () => pending });
  const acquisition = pool.acquire("proof", "one");
  const rejected = assert.rejects(acquisition, /replaced/);
  await new Promise((resolve) => setImmediate(resolve));
  await pool.invalidate("proof");
  ready({ close: async () => closed++ });
  await rejected;
  assert.equal(closed, 1);
  assert.equal(pool.state("proof").status, "disconnected");
});

test("cancelled pool waiter does not cancel connection needed by another caller", async () => {
  let ready;
  const connection = new Promise((resolve) => (ready = resolve)),
    pool = createMcpPool({ connect: () => connection }),
    controller = new AbortController();
  const cancelled = pool.acquire("proof", "one", controller.signal),
    rejected = assert.rejects(cancelled),
    survivor = pool.acquire("proof", "one");
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(pool.state("proof").status, "connecting");
  const client = { close: async () => {} };
  ready(client);
  assert.equal(await survivor, client);
  assert.equal(pool.state("proof").status, "connected");
  await pool.close();
});
