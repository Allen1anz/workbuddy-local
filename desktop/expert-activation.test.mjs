import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createAppServer } from "../server/app.mjs";
const { createDispatcher } = createRequire(import.meta.url)("./dispatcher.cjs");
test("expert activation validates actual package and returns original active expert wrapper", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-activation-")),
    dataDir = path.join(profile, "data");
  const root = path.join(
    profile,
    "expert-config/plugins/marketplaces/my-experts/plugins/active-proof",
  );
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({
      name: "active-proof",
      expertType: "agent",
      agentName: "main",
      version: "1.0.0",
    }),
  );
  await fs.writeFile(path.join(root, "agents/main.md"), "ACTIVATION_INSTRUCTIONS");
  const server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = { origin: "http://127.0.0.1:" + server.address().port, dataDir },
    d = createDispatcher(options);
  try {
    assert.deepEqual(await d("expert:getActivePlugins"), { experts: [] });
    const originalRename = fs.rename;
    let failOnce = true;
    fs.rename = async (...args) => {
      if (args[1] === path.join(dataDir, "desktop-settings.json") && failOnce) {
        failOnce = false;
        throw Error("INJECTED_SAVE_FAILURE");
      }
      return originalRename(...args);
    };
    try {
      const results = await Promise.all([
        d("expert:activatePlugin", [{ expertId: "custom-expert:active-proof" }]),
        d("expert:activatePlugin", [{ expertId: "custom-expert:active-proof" }]),
      ]);
      assert.deepEqual(results.map((result) => result.success).sort(), [false, true]);
      assert.deepEqual(await d("expert:getActivePlugins"), {
        experts: ["custom-expert:active-proof"],
      });
      assert.deepEqual(await createDispatcher(options)("expert:getActivePlugins"), {
        experts: ["custom-expert:active-proof"],
      });
    } finally {
      fs.rename = originalRename;
    }
    assert.equal((await d("expert:activatePlugin", [{ expertId: "missing" }])).success, false);
    const activated = await d("expert:activatePlugin", [
      { expertId: "custom-expert:active-proof", pluginName: "active-proof" },
    ]);
    assert.equal(activated.success, true);
    assert.equal(activated.agentName, "main");
    assert.equal(activated.localPath, await fs.realpath(root));
    assert.equal(activated.pluginRegisteredName, "active-proof");
    assert.equal(activated.version, "1.0.0");
    assert.equal(activated.nativePluginRuntimeAvailable, false);
    assert.deepEqual(await createDispatcher(options)("expert:getActivePlugins"), {
      experts: ["custom-expert:active-proof"],
    });
    assert.equal(
      (
        await d("expert:activatePlugin", [
          { expertId: "custom-expert:active-proof", pluginName: "wrong" },
        ])
      ).success,
      false,
    );
    assert.equal(
      await d("expert:deactivatePlugin", [{ expertId: "custom-expert:active-proof" }]),
      undefined,
    );
    assert.deepEqual(await d("expert:getActivePlugins"), { experts: [] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
