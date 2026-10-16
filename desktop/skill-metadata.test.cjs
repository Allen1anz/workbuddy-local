const test = require("node:test"),
  assert = require("node:assert/strict");
const { skillFlags } = require("./skill-metadata.cjs");
const { skillTextMetadata } = require("./skill-metadata.cjs");
const { skillInvocationChanges } = require("./skill-metadata.cjs");
test("edited invocation flags synchronize and removing flags restores defaults", () => {
  const before = "---\nname: proof\n---\nBody";
  const after = "---\nname: proof\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody";
  assert.deepEqual(skillInvocationChanges(before, after), { enabled: false, disableModelInvocation: true, userInvocable: false });
  assert.deepEqual(skillInvocationChanges(after, before), { enabled: true, disableModelInvocation: false, userInvocable: true });
  assert.deepEqual(skillInvocationChanges(before, before + " changed body"), {});
});
test("skill display metadata reads quoted and multiline headers without using body fields", () => {
  assert.deepEqual(skillTextMetadata('---\nname: "proof"\ndescription: "Text # kept"\n---\ndescription: ignored'), { name: "proof", description: "Text # kept" });
  assert.deepEqual(skillTextMetadata("---\r\nname: 'writer''s'\r\ndescription: >-\r\n  First line\r\n  Second line\r\nuser-invocable: true\r\n---\r\nbody"), { name: "writer's", description: "First line Second line" });
  assert.equal(skillTextMetadata("---\ndescription: |\n  One\n  Two\n---\nbody").description, "One\nTwo");
  assert.deepEqual(skillTextMetadata("description: body"), {});
});
test("skill invocation flags parse only top-level typed booleans in frontmatter", () => {
  assert.deepEqual(
    skillFlags(
      "---\nname: proof\ndisable-model-invocation: true # comment\nuser-invocable: false\n---\nbody",
    ),
    { disableModelInvocation: true, userInvocable: false },
  );
  assert.deepEqual(skillFlags("---\r\ndisable-model-invocation: FALSE\r\n---\r\nbody"), {
    disableModelInvocation: false,
  });
  assert.deepEqual(
    skillFlags('---\ndisable-model-invocation: "true"\n---\nuser-invocable: false'),
    {},
  );
  assert.deepEqual(skillFlags("disable-model-invocation: true"), {});
});
