import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../server/app.mjs";
import { modelRoutes } from "./model.mjs";

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

test("model test sends only a fixed question to configured endpoint and rejects incompatible responses", async () => {
  let sent,
    compatible = true;
  const model = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    sent = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        compatible ? { choices: [{ message: { content: "OK" } }] } : { unexpected: true },
      ),
    );
  });
  const modelURL = await listen(model);
  const dir = await mkdtemp(join(tmpdir(), "wb-model-test-"));
  const app = createAppServer({ dataDir: dir, extraRoutes: modelRoutes() });
  const url = await listen(app);
  const request = (path, body) =>
    fetch(url + path, {
      method: path === "/api/config" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await request("/api/model/test", {})).status, 400);
    await request("/api/config", { baseURL: modelURL + "/v1", model: "protocol-test" });
    assert.equal((await request("/api/model/test", {})).status, 200);
    assert.deepEqual(sent.messages, [{ role: "user", content: "Reply with exactly the word OK." }]);
    assert.equal(sent.tools, undefined);
    compatible = false;
    assert.equal((await request("/api/model/test", {})).status, 400);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});
