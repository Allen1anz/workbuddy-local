import fs from "node:fs/promises";
import path from "node:path";
const names = ["skill-creator", "expert-manager"];

/** Copy licensed packages once. Never overwrite an installed user's edits. */
export async function installOpenSkills(dataDir, source = path.resolve(import.meta.dirname, "../open-skills")) {
  const skills = [];
  await fs.mkdir(path.join(dataDir, "skills"), { recursive: true, mode: 0o700 });
  for (const name of names) {
    const destination = path.join(dataDir, "skills", "open-" + name);
    try { await fs.access(path.join(destination, "SKILL.md")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.cp(path.join(source, name), destination, { recursive: true, force: false, errorOnExist: true });
    }
    const content = await fs.readFile(path.join(destination, "SKILL.md"), "utf8");
    skills.push({ id: "open:" + name, name, content, localRootDir: destination, enabled: true,
      description: name === "skill-creator" ? "创建与维护本地技能" : "创建与维护本地专家包",
      license: "Apache-2.0", source: "bundled-open-source", securityScanPerformed: false,
    });
  }
  return skills;
}
