import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { bundledResourcesTool } from "./bundled-resources.mjs";

test("packaged references can be read without path or symlink escape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-resources-"));
  await fs.mkdir(path.join(root, "vendor"));
  await fs.writeFile(path.join(root, "vendor", "guide.md"), "reference");
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  await fs.symlink(path.join(root, "secret.txt"), path.join(root, "vendor", "escape.txt"));
  const tool = bundledResourcesTool(root);
  assert.deepEqual(await tool.handler({ resourcePath: "vendor/guide.md" }), { resourcePath: "vendor/guide.md", content: "reference", executed: false });
  await assert.rejects(tool.handler({ resourcePath: "vendor/../secret.txt" }), /escapes/);
  await assert.rejects(tool.handler({ resourcePath: "vendor/escape.txt" }), /escapes/);
  await assert.rejects(tool.handler({ resourcePath: "/etc/passwd" }), /vendor/);
});
