import test from "node:test";
import assert from "node:assert/strict";
import { collectMcpList } from "./mcp-list.mjs";

test("MCP paginated lists preserve order and forward opaque cursors and cancellation", async () => {
  const signal = new AbortController().signal,
    calls = [];
  const client = {
    async listTools(params, options) {
      calls.push(params);
      assert.equal(options.signal, signal);
      return params.cursor === undefined
        ? { tools: [{ name: "first" }], nextCursor: "opaque:second" }
        : { tools: [{ name: "second" }] };
    },
  };
  assert.deepEqual(await collectMcpList(client, "listTools", "tools", { signal }), {
    tools: [{ name: "first" }, { name: "second" }],
  });
  assert.deepEqual(calls, [{}, { cursor: "opaque:second" }]);
});

test("MCP repeated pagination cursor rejects partial success", async () => {
  let requests = 0;
  await assert.rejects(
    collectMcpList(
      {
        async listResources() {
          requests++;
          return { resources: [], nextCursor: "loop" };
        },
      },
      "listResources",
      "resources",
    ),
    /cursor repeated/,
  );
  assert.equal(requests, 2);
});
