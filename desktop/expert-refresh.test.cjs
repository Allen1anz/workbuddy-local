const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDispatcher } = require("./dispatcher.cjs");

test("expert list and refresh reload edited package metadata and instructions", async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-refresh-"));
  const dataDir = path.join(root, "data");
  const packageRoot = path.join(root, "expert-config/plugins/marketplaces/my-experts/plugins/refresh-proof");
  await fs.mkdir(path.join(packageRoot, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "agents"));
  const write = async (label, instructions) => {
    await fs.writeFile(path.join(packageRoot, ".codebuddy-plugin/plugin.json"), JSON.stringify({
      name: "refresh-proof", agentName: "main", expertType: "agent",
      displayName: label, displayDescription: "Product refresh verification",
    }));
    await fs.writeFile(path.join(packageRoot, "agents/main.md"), instructions);
  };
  await write("Before edit", "Old instructions");
  const server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const dispatch = createDispatcher({ origin: "http://127.0.0.1:" + server.address().port, dataDir });
    const find = (result) => result.experts.find((item) => item.id === "custom-expert:refresh-proof");
    assert.equal(find(await dispatch("expert:getExperts")).name, "Before edit");
    await write("After edit", "New instructions");
    assert.equal(find(await dispatch("expert:refresh")).name, "After edit");
    assert.deepEqual(find(await dispatch("expert:refresh")).description, { zh: "Product refresh verification", en: "Product refresh verification" });
    const detail = await dispatch("expert:getExpert", ["custom-expert:refresh-proof"]);
    assert.equal(detail.expert.systemPrompt, "New instructions");
    await write("Final edit", "Final instructions");
    assert.equal(find(await dispatch("expert:getMarketExperts")).name, "Final edit");
    const manifest = path.join(packageRoot, ".codebuddy-plugin/plugin.json");
    await fs.rename(manifest, manifest + ".saved");
    const unavailable = await dispatch("expert:refresh");
    assert.equal(find(unavailable), undefined);
    assert.equal(unavailable.errors[0].directory, "refresh-proof");
    await assert.rejects(dispatch("expert:getExpert", ["custom-expert:refresh-proof"]), /unavailable/);
    await fs.rename(manifest + ".saved", manifest);
    assert.equal(find(await dispatch("expert:refresh")).name, "Final edit");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("skill list reloads edited instructions without changing identity or enabled state", { skip: process.env.WORKBUDDY_PUBLIC_TESTS === "1" ? "Proprietary fixture excluded from public source release" : false }, async () => {
  const { createAppServer } = await import("../server/app.mjs");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-skill-refresh-"));
  const packageRoot = path.join(dataDir, "skills/proof");
  await fs.mkdir(packageRoot, { recursive: true });
  const filename = path.join(packageRoot, "SKILL.md");
  const before = "---\nname: before-edit\n---\nOld instructions";
  await fs.writeFile(filename, before);
  const server = createAppServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const response = await fetch(origin + "/api/skills", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Proof", content: before, localRootDir: packageRoot, enabled: false }),
    });
    assert.equal(response.ok, true);
    const stored = await response.json();
    const dispatch = createDispatcher({ origin, dataDir });
    const after = "---\nname: after-edit\ndescription: >-\n  Updated product\n  description\n---\nNew instructions";
    await fs.writeFile(filename, after);
    const item = (await dispatch("skill:list")).results.find((skill) => skill.id === stored.id);
    assert.equal(item.name, "after-edit");
    assert.equal(item.enabled, false);
    assert.equal(item.content, after);
    assert.equal(item.description, "Updated product description");
    assert.equal((await dispatch("skill:getContent", [{ id: stored.id }])).content, after);
    assert.equal((await createDispatcher({ origin, dataDir })("skill:list")).results.find((skill) => skill.id === stored.id).name, "after-edit");
    await fs.writeFile(filename, after.replace("name: after-edit", "name: after-edit\ndisable-model-invocation: true\nuser-invocable: false"));
    const disabled = (await dispatch("skill:list")).results.find((skill) => skill.id === stored.id);
    assert.equal(disabled.disableModelInvocation, true);
    assert.equal(disabled.userInvocable, false);
    await fs.writeFile(filename, after);
    const restored = (await dispatch("skill:list")).results.find((skill) => skill.id === stored.id);
    assert.equal(restored.enabled, true);
    assert.equal(restored.disableModelInvocation, false);
    assert.equal(restored.userInvocable, true);
    await fs.rename(filename, filename + ".saved");
    const unavailable = await dispatch("skill:list");
    assert.equal(unavailable.results.some(skill => skill.id === stored.id), false);
    assert.equal(unavailable.errors.some(item => item.id === stored.id), true);
    assert(unavailable.results.length > 0);
    await fs.rename(filename + ".saved", filename);
    assert.equal((await dispatch("skill:list")).results.some(skill => skill.id === stored.id), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
