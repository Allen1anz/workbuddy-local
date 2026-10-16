const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { watchSkillPackages } = require("./skill-package-watch.cjs");
test("nested package writes, disappearance and restoration notify, shutdown stops watching", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-skill-watch-"));
  await fs.mkdir(path.join(root, "package"));
  let waiting, count = 0;
  const watcher = watchSkillPackages(root, () => { count++; waiting?.(); });
  const change = async action => {
    await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(Error("package notification timed out")), 5000);
      waiting = () => { clearTimeout(timer); waiting = null; resolve(); };
      try { await action(); } catch (error) { clearTimeout(timer); reject(error); }
    });
  };
  const file = path.join(root, "package/SKILL.md"), backup = file + ".saved";
  try {
    await change(() => fs.writeFile(file, "initial"));
    // macOS may coalesce a rapid rename/restore into one directory event.
    await change(async () => {
      await fs.rename(file, backup);
      await fs.rename(backup, file);
      await fs.writeFile(file, "restored");
    });
    assert.equal(await fs.readFile(file, "utf8"), "restored");
    assert.ok(count >= 2);
    watcher.close();
    const closedCount = count;
    await fs.writeFile(file, "after close");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(count, closedCount);
  } finally { watcher.close(); }
});
