import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewExtension } from "./preview.mjs";

test("local preview serves approved directory and rejects symlink escape and mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-preview-"));
  const site = join(dir, "site");
  await mkdir(site);
  await writeFile(join(site, "index.html"), "<h1>Preview</h1>");
  await writeFile(join(dir, "private.txt"), "outside");
  await symlink(join(dir, "private.txt"), join(site, "escape.txt"));
  const extension = previewExtension();
  try {
    assert.equal(extension.tool.requiresApproval, true);
    const result = await extension.tool.handler({ path: "site" }, { safePath: async () => site });
    assert.equal(await (await fetch(result.url)).text(), "<h1>Preview</h1>");
    assert.equal((await fetch(new URL("escape.txt", result.url))).status, 403);
    assert.equal((await fetch(result.url, { method: "POST" })).status, 405);
    assert.equal(result.scope, "localhost-only");
    assert.equal(
      (await extension.tool.handler({ path: "site" }, { safePath: async () => site })).url,
      result.url,
    );
  } finally {
    extension.close();
  }
});
