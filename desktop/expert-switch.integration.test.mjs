import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createAppServer } from "../server/app.mjs";
const { createDispatcher } = createRequire(import.meta.url)("./dispatcher.cjs");

test("desktop expert switch updates one real session and backend rejects stale concurrent binding", async () => {
  const dataDir = join(await mkdtemp(join(tmpdir(), "wb-expert-switch-")), "data"),
    server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = (route, method = "GET", body) =>
    fetch(origin + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const events = [],
    dispatcher = createDispatcher({
      origin,
      dataDir,
      emit: (channel, result) => events.push({ channel, result }),
    });
  try {
    await request("/experts/one", "PUT", {
      name: "Writer",
      plugin: { name: "writer" },
      agentName: "main",
      systemPrompt: "WRITER_INSTRUCTIONS",
    });
    await request("/experts/two", "PUT", {
      name: "Coder",
      plugin: { name: "coder" },
      agentName: "main",
      systemPrompt: "CODER_INSTRUCTIONS",
    });
    const session = await (
      await request("/sessions", "POST", {
        expertId: "one",
        config: { expertId: "one", model: "unchanged" },
      })
    ).json();
    const other = await (await request("/sessions", "POST", { expertId: "one" })).json();
    assert.equal(
      await dispatcher("expert:switchPluginForSession", [
        {
          sessionId: session.id,
          disablePluginName: "writer",
          enablePluginName: "coder",
          agentName: "main",
          sourcePluginId: "coder@local",
        },
      ]),
      undefined,
    );
    const updated = await (await request("/sessions/" + session.id)).json();
    assert.equal(updated.expertId, "two");
    assert.equal(updated.config.expertId, "two");
    const identity = JSON.parse(updated.config.runtimeIdentity.slice("expert-v2:".length));
    assert.equal(identity.expertId, "two");
    assert.equal(identity.agentName, "main");
    assert.equal(identity.pluginRegisteredName, undefined);
    assert.equal(updated.expertRuntimeIdentity, updated.config.runtimeIdentity);
    assert.equal(updated.config.model, "unchanged");
    assert.equal(updated.config.expertPluginBinding.nativePluginRuntimeAvailable, false);
    assert.equal((await (await request("/sessions/" + other.id)).json()).expertId, "one");
    assert(
      events.some(
        (event) => event.channel === "session:upserted" && event.result.expertId === "two",
      ),
    );
    const body = { expectedExpertId: "two", enablePluginName: "writer", agentName: "main" };
    const responses = await Promise.all([
      request("/sessions/" + session.id + "/expert-switch", "POST", body),
      request("/sessions/" + session.id + "/expert-switch", "POST", body),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await (await request("/sessions/" + session.id)).json()).expertId, "one");
    await request("/experts/custom-expert:gone", "PUT", {
      name: "Gone",
      declaredPlugin: "gone",
      source: "local-expert-package",
      systemPrompt: "STALE",
    });
    assert.equal(
      (
        await request("/sessions/" + session.id + "/expert-switch", "POST", {
          enablePluginName: "gone",
        })
      ).status,
      400,
    );
    assert.equal((await (await request("/sessions/" + session.id)).json()).expertId, "one");
    await assert.rejects(
      dispatcher("expert:switchPluginForSession", [
        { sessionId: session.id, enablePluginName: "missing" },
      ]),
      /not installed/,
    );
    assert.equal((await (await request("/sessions/" + session.id)).json()).expertId, "one");
    await dispatcher("expert:switchPluginForSession", [
      { sessionId: session.id, disablePluginName: "writer" },
    ]);
    const cleared = await (await request("/sessions/" + session.id)).json();
    assert.equal(cleared.expertId, null);
    assert.equal(cleared.config.runtimeIdentity, null);
    assert.equal(cleared.expertRuntimeIdentity, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
