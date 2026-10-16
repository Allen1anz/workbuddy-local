"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { testModelConnectivity } = require("./model-connectivity.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");

test("5.8.3 daemon and SDK connection routes preserve the saved model list", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-model-probe-"));
  const events = [];
  const dispatch = createDispatcher({ origin: "http://127.0.0.1:18723", dataDir, emit: (...args) => events.push(args),
    fetchImpl: async () => Response.json({ choices: [{ message: { content: "OK" } }] }),
  });
  const before = await dispatch("config:getLocalCustomModels");
  const saved = await fs.readFile(path.join(dataDir, "desktop-settings.json"), "utf8");
  for (const channel of ["config:testLocalCustomModel", "wb:models:testLocalCustomModel"])
    assert.deepEqual(await dispatch(channel, [{ id: "test", url: "http://localhost/v1/chat/completions" }]), { ok: true });
  assert.deepEqual(await dispatch("config:getLocalCustomModels"), before);
  assert.equal(await fs.readFile(path.join(dataDir, "desktop-settings.json"), "utf8"), saved);
  assert.deepEqual(events, []);
});

test("connection probe sends a bounded nonstreaming completion to the exact endpoint", async () => {
  const model = { id: "local-test", url: "http://127.0.0.1:18725/v1/chat/completions", apiKey: "test-only" };
  const before = structuredClone(model);
  const result = await testModelConnectivity(model, { fetchImpl: async (url, options) => {
    assert.equal(url, model.url);
    assert.equal(options.headers.Authorization, "Bearer test-only");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { model: "local-test", messages: [{ role: "user", content: "Reply OK." }], max_tokens: 1, stream: false });
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(model, before);
});

test("provider failures are classified without returning response bodies or credentials", async () => {
  for (const [status, errorCode] of [[401, "NOT_AUTHENTICATED"], [403, "NOT_AUTHENTICATED"], [429, "RATE_LIMITED"], [500, "HTTP_ERROR"]]) {
    assert.deepEqual(await testModelConnectivity({ id: "test", url: "https://example.invalid/v1/chat/completions" }, {
      fetchImpl: async () => new Response("sensitive-provider-error", { status }),
    }), { ok: false, errorCode });
  }
});

test("HTML, missing choices and oversized responses cannot report a successful connection", async () => {
  for (const body of ["<html>login</html>", "{}", "x".repeat(65537)]) {
    assert.deepEqual(await testModelConnectivity({ id: "test", url: "http://localhost/v1/chat/completions" }, {
      fetchImpl: async () => new Response(body),
    }), { ok: false, errorCode: "INVALID_RESPONSE" });
  }
});

test("invalid endpoints are rejected before requests; network errors and timeouts remain distinct", async () => {
  for (const url of ["file:///tmp/model", "https://user:secret@example.invalid/v1", "invalid"]) {
    assert.deepEqual(await testModelConnectivity({ id: "test", url }, { fetchImpl: async () => { throw Error("must not request"); } }), { ok: false, errorCode: "INVALID_ARGUMENT" });
  }
  const model = { id: "test", url: "http://localhost/v1/chat/completions" };
  assert.deepEqual(await testModelConnectivity(model, { fetchImpl: async () => { throw Error("private diagnostic"); } }), { ok: false, errorCode: "NETWORK" });
  assert.deepEqual(await testModelConnectivity(model, { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })) }), { ok: false, errorCode: "TIMEOUT" });
});
