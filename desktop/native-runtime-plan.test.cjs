const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNativeRuntimePlan } = require("./native-runtime-plan.cjs");
const input = { executable: "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
  cliPath: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
  root: "/tmp/workbuddy-isolated", modelId: "/models/qwen3", port: 18726 };

test("native launch contract isolates configuration and never inherits authentication", () => {
  const plan = buildNativeRuntimePlan(input);
  assert.equal(plan.env.HOME, "/tmp/workbuddy-isolated/home");
  assert.equal(plan.env.CODEBUDDY_CONFIG_DIR, plan.env.WORKBUDDY_CONFIG_DIR);
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(plan.env.CODEBUDDY_AUTH_TOKEN, undefined);
  assert.equal(plan.models.models[0].url, "http://127.0.0.1:18725/v1");
  assert.equal(plan.args.at(-1), "custom-local:/models/qwen3");
  assert.equal(plan.acpURL, "http://127.0.0.1:18726/api/v1/acp");
  assert.equal(plan.requiresNetworkBoundary, true);
  assert.equal(plan.settings["http.proxySupport"], "off");
  assert.deepEqual(plan.settingsFiles, ["/tmp/workbuddy-isolated/config/settings.json",
    "/tmp/workbuddy-isolated/home/.workbuddy/settings.json"]);
});

test("native launch rejects ambiguous paths, model IDs and colliding ports", () => {
  for (const patch of [{ root: "relative" }, { modelId: "" },
    { modelId: "custom-local:qwen" }, { port: 18725 }, { port: 0 }, { modelPort: 65536 }])
    assert.throws(() => buildNativeRuntimePlan({ ...input, ...patch }));
});

test("native plugin directories preserve path arguments and reject relative entries", () => {
  const plan = buildNativeRuntimePlan({ ...input, pluginDirs: ["/tmp/plugin one", "/tmp/plugin one", "/tmp/plugin-two"] });
  assert.deepEqual(plan.args.slice(-3), ["--plugin-dir", "/tmp/plugin one", "/tmp/plugin-two"]);
  assert.throws(() => buildNativeRuntimePlan({ ...input, pluginDirs: ["relative"] }));
});
