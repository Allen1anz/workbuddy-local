"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDispatcher } = require("./dispatcher.cjs");

test("5.8.3 theme preferences and local selection persist without official service calls", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-appearance-"));
  const options = { origin: "http://127.0.0.1:18723", dataDir, fetchImpl: async () => { throw Error("must remain local"); } };
  let dispatch = createDispatcher(options);
  await dispatch("wb:config:setPreference", ["appearance-mode", "dark"]);
  await dispatch("wb:config:setTheme", ["dark"]);
  await dispatch("appearance:setSelection", ["theme", "dark"]);
  dispatch = createDispatcher(options);
  assert.equal(await dispatch("wb:config:preference", ["appearance-mode"]), "dark");
  assert.equal(await dispatch("config:get", ["theme"]), "dark");
  assert.deepEqual(await dispatch("config:get", ["appearanceSelection"]), { type: "theme", resourceKey: "dark" });
  await assert.rejects(dispatch("appearance:setSelection", ["theme", "unavailable-cloud-skin"]), /unavailable/);
  await assert.rejects(dispatch("wb:config:setTheme", ["invalid"]), /Unsupported/);
  assert.equal(await dispatch("config:get", ["theme"]), "dark");
});
