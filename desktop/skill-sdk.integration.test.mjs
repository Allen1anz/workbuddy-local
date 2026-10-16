import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createAppServer } from "../server/app.mjs";
const { createDispatcher } = createRequire(import.meta.url)("./dispatcher.cjs");

test("5.8.3 installed skills return SDK references and a stable version that changes with content", { skip: process.env.WORKBUDDY_PUBLIC_TESTS === "1" ? "Proprietary fixture excluded from public source release" : false }, async t => {
  const dataDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wb-skill-sdk-")), "data");
  const server = createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dispatch = createDispatcher({ origin, dataDir });
  const installed = await dispatch("wb:skills:installed", [{ excludePluginSkills: true }]);
  assert.ok(installed.items.length > 0);
  assert.ok(installed.items.every(skill => skill.ref === skill.filePath && skill.slug === skill.name && skill.source !== "plugin"));
  const before = await dispatch("skill:getSkillsVersion");
  assert.ok(Number.isSafeInteger(before.version) && before.version > 0);
  assert.deepEqual(await dispatch("skill:getSkillsVersion"), before);
  const response = await fetch(origin + "/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "sdk-version-test", content: "---\nname: sdk-version-test\ndescription: test\n---\nText only." }) });
  assert.equal(response.status, 200);
  const after = await dispatch("skill:getSkillsVersion");
  assert.ok(after.version > before.version);
  assert.deepEqual(await dispatch("skill:getSkillsVersion"), after);
});
