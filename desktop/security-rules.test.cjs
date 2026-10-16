const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDispatcher } = require("./dispatcher.cjs");
test("product rules persist across reopening and invalid changes preserve the saved configuration", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-security-product-"));
  const options = { origin: "http://127.0.0.1:18723", dataDir };
  const dispatch = createDispatcher(options);
  const result = await dispatch("securityCenter:saveSandboxRulesConfig", [{
    fileSafety: { allowlist: [], blocklist: ["/tmp/product-verification"] },
    commandSafety: { ask: [{ prefix: ["rm"] }], allow: [] },
    fileBackup: { enabled: false, maxSizeMB: 25 },
    deniedDomains: ["example.invalid"], denyAll: false,
  }]);
  assert.equal(result.runtimeApplied, false);
  const reopened = createDispatcher(options);
  const baseline = await reopened("securityCenter:getState");
  assert.deepEqual(baseline.fileSafetyRules.blocklist, ["/tmp/product-verification"]);
  assert.deepEqual(baseline.commandSafetyRules.ask, [{ prefix: ["rm"] }]);
  assert.equal(baseline.sandboxEnabled, false);
  for (const invalid of [{ fileSafety: { blocklist: [42] } },
    { commandSafety: { allow: [{ prefix: "anything" }] } },
    { fileBackup: { enabled: "yes" } }, { fileBackup: { maxSizeMB: -1 } },
    { deniedDomains: "invalid" }, { denyAll: 1 }]) {
    await assert.rejects(reopened("securityCenter:saveSandboxRulesConfig", [invalid]));
    assert.deepEqual(await reopened("securityCenter:getState"), baseline);
  }
  await reopened("securityCenter:saveSandboxRulesConfig", [{ fileSafety: null }]);
  const reset = await createDispatcher(options)("securityCenter:getState");
  assert.equal(reset.fileSafetyRules, null);
  assert.deepEqual(reset.commandSafetyRules, baseline.commandSafetyRules);
  assert.deepEqual(reset.sandboxRules, baseline.sandboxRules);
});
