import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateOffice } from "./office.mjs";
import { officeEditTools } from "./office-edit.mjs";

test("existing office text can be inspected and replaced in a separate copy without changing original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-office-edit-"));
  const tools = officeEditTools(dir);
  const reader = tools.find((tool) => tool.definition.function.name === "office_read");
  const editor = tools.find((tool) => tool.definition.function.name === "office_replace");
  assert.equal(editor.requiresApproval, true);
  const context = { safePath: async (name) => resolve(dir, name) };
  for (const spec of [
    { format: "docx", title: "原始标题", paragraphs: ["旧内容 & 保留"] },
    { format: "xlsx", title: "表格", rows: [["旧内容", 12]] },
    { format: "pptx", title: "演示", slides: [{ title: "第一张", body: ["旧内容"] }] },
  ]) {
    const source = await generateOffice(spec, dir);
    const before = await readFile(join(dir, source.filename));
    const original = await reader.handler({ path: source.filename }, context);
    assert.ok(JSON.stringify(original).includes("旧内容"));
    const edited = await editor.handler(
      {
        path: source.filename,
        title: "修订",
        replacements: [
          { from: "旧内容", to: "新内容 <>&" },
          { from: "不存在", to: "无法替换" },
        ],
      },
      context,
    );
    assert.deepEqual(edited.counts, [1, 0]);
    assert.deepEqual(edited.unmatched, ["不存在"]);
    const editedContent = await reader.handler({ path: "artifacts/" + edited.filename }, context);
    assert.ok(JSON.stringify(editedContent).includes("新内容 <>&"));
    assert.deepEqual(await readFile(join(dir, source.filename)), before);
  }
});

test("generated artifacts can be read and revised without exposing private application files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-office-artifact-"));
  const tools = officeEditTools(dir);
  const reader = tools.find((tool) => tool.definition.function.name === "office_read");
  const editor = tools.find((tool) => tool.definition.function.name === "office_replace");
  const artifact = await generateOffice(
    { format: "docx", title: "自己的产物", paragraphs: ["原文"] },
    join(dir, "artifacts"),
  );
  const context = {
    safePath: async () => {
      throw new Error("Private application data denied");
    },
  };
  assert.ok(
    JSON.stringify(await reader.handler({ artifactId: artifact.id }, context)).includes("原文"),
  );
  const revised = await editor.handler(
    { artifactId: artifact.id, title: "修订稿", replacements: [{ from: "原文", to: "新文" }] },
    context,
  );
  assert.ok(
    JSON.stringify(await reader.handler({ artifactId: revised.id }, context)).includes("新文"),
  );
  await assert.rejects(reader.handler({ artifactId: "../../workbuddy.sqlite" }, context));
});
