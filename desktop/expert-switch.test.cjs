const test = require("node:test"),
  assert = require("node:assert/strict");
const { resolveExpertSwitch } = require("./expert-switch.cjs");
const expert = { id: "custom-expert:writer", declaredPlugin: "writer", agentName: "main" };
const session = { id: "session", expertId: "old" };
test("expert runtime identity matches shipped renderer builder", { skip: process.env.WORKBUDDY_PUBLIC_TESTS === "1" ? "Proprietary fixture excluded from public source release" : false }, async () => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    vm = require("node:vm");
  const { buildExpertRuntimeIdentity } = require("./expert-switch.cjs");
  const source = await fs.readFile(
    path.join(__dirname, "../desktop-ui/assets/index-BZi9u85P.js"),
    "utf8",
  );
  const start = source.indexOf("\tbuildExpertRuntimeIdentity(expert) {"),
    end = source.indexOf("\n\tnormalizeExpertRuntimeIdentityForComparison", start);
  assert(start >= 0 && end > start);
  const original = vm.runInNewContext(
    "({" +
      source.slice(start, end) +
      ", readExpertRuntimeIdentityField(value) { if (typeof value === 'string') return value.trim() || undefined; if (typeof value === 'number' && Number.isFinite(value)) return String(value); }})",
    {},
    { timeout: 1000 },
  );
  for (const metadata of [
    {},
    { id: "expert" },
    {
      id: "expert",
      pluginName: " writer ",
      agentName: " main ",
      updatedAt: 123,
      summonTimestamp: 456,
    },
    { id: "expert", summonTimestamp: 456, summonTimestampReliable: false },
    { id: "expert", summonTimestamp: Infinity },
  ])
    assert.equal(
      buildExpertRuntimeIdentity(metadata),
      original.buildExpertRuntimeIdentity(metadata),
    );
});
test("expert switch resolves original plugin and agent parameters without pretending native runtime", () => {
  const plan = resolveExpertSwitch(
    {
      sessionId: "session",
      disablePluginName: "old",
      enablePluginName: "writer",
      agentName: "main",
      sourcePluginId: "writer@my-experts",
    },
    session,
    [expert],
  );
  assert.equal(plan.expertId, expert.id);
  assert.equal(plan.expectedExpertId, "old");
  assert.equal(plan.binding.sourcePluginId, "writer@my-experts");
  assert.equal(plan.binding.nativePluginRuntimeAvailable, false);
  assert.equal(
    resolveExpertSwitch({ sessionId: "session", disablePluginName: "old" }, session, [expert])
      .expertId,
    null,
  );
  assert.equal(
    resolveExpertSwitch({ sessionId: "session", disablePluginName: "unrelated" }, session, [
      expert,
    ]),
    null,
  );
});
test("expert switch rejects missing, ambiguous and incompatible targets before mutation", () => {
  assert.throws(
    () =>
      resolveExpertSwitch({ sessionId: "session", enablePluginName: "missing" }, session, [expert]),
    /not installed/,
  );
  assert.throws(
    () =>
      resolveExpertSwitch({ sessionId: "session", enablePluginName: "writer" }, session, [
        expert,
        { ...expert, id: "second" },
      ]),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      resolveExpertSwitch(
        { sessionId: "session", enablePluginName: "writer", agentName: "other" },
        session,
        [expert],
      ),
    /agent is unavailable/,
  );
  assert.throws(
    () =>
      resolveExpertSwitch(
        {
          sessionId: "session",
          enablePluginName: "writer",
          internalModelRequestHeaders: { authorization: "dummy" },
        },
        session,
        [expert],
      ),
    /native plugin runtime/,
  );
});
