const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createQaRpcTrace } = require("./qa-rpc-trace.cjs");
test("QA trace captures skill blocks/public bindings and redacts private configuration", () => {
  const logs = [],
    trace = createQaRpcTrace({ enabled: true, writeLog: (s) => logs.push(s) });
  trace("session:sendMessage", [
    "sid",
    {
      prompt: [
        {
          type: "resource_link",
          uri: "skill://canonical",
          name: "canonical",
          _meta: { binding: "selected", apiKey: "secretA" },
        },
      ],
      config: { model: "qa", mode: "craft", apiKey: "secretB", auth: { token: "secretC" } },
      headers: { Authorization: "secretD" },
    },
  ]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /skill:\/\/canonical/);
  assert.match(logs[0], /"model":"qa"/);
  assert.doesNotMatch(logs[0], /secret[ABCD]|Authorization|apiKey|token/);
  trace("session:prompt", ["sid", [{ type: "text", text: "@skill:canonical" }]]);
  assert.match(logs[1], /@skill:canonical/);
  trace("auth:getAccount", [{ uid: "private" }]);
  assert.equal(logs.length, 2);
});
test("normal profile tracing remains disabled", () => {
  const logs = [],
    trace = createQaRpcTrace({ enabled: false, writeLog: (s) => logs.push(s) });
  trace("session:create", { prompt: "data" });
  assert.deepEqual(logs, []);
});
