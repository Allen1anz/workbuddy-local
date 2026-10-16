"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { expertManifestPath } = require("./expert-zip.cjs");
function teamMemberId(member) {
  for (const value of [member.agent_name, member.agent, member.id, member.name]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
}
async function scanCustomExperts(configDir) {
  const parent = path.join(configDir, "plugins/marketplaces/my-experts/plugins");
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { experts: [], errors: [] };
    throw error;
  }
  const experts = [],
    errors = [];
  const within = (root, target) => target === root || target.startsWith(root + path.sep);
  const configRoot = await fs.realpath(configDir),
    parentRoot = await fs.realpath(parent);
  if (!within(configRoot, parentRoot)) throw Error("Expert registry escapes config root");
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const root = await fs.realpath(path.join(parent, entry.name));
      if (!within(await fs.realpath(parent), root))
        throw Error("Expert directory escapes config root");
      const read = async (relative) => {
        const candidate = path.resolve(root, relative);
        if (!within(root, candidate)) throw Error("Expert resource escapes directory");
        const real = await fs.realpath(candidate);
        if (!within(root, real)) throw Error("Expert symlink escapes directory");
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size > 100000)
          throw Error("Expert resource must be a file under 100000 bytes");
        return fs.readFile(real, "utf8");
      };
      let manifestText;
      try {
        manifestText = await read(".codebuddy-plugin/plugin.json");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        manifestText = await read(".workbuddy-plugin/plugin.json");
      }
      const manifest = JSON.parse(manifestText);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name || ""))
        throw Error("Invalid expert name");
      if (manifest.name !== entry.name) throw Error("Expert name must match directory name");
      const isTeam = manifest.expertType === "team";
      const agentName = isTeam ? manifest.teamInfo?.leadAgent : manifest.agentName;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentName || ""))
        throw Error("Invalid agentName");
      const prompt = await read("agents/" + agentName + ".md");
      if (!prompt.trim()) throw Error("Expert instructions are empty");
      let createdBySession = null;
      try {
        createdBySession = (await read(".created-by-session")).trim() || null;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const localized = (value) => (typeof value === "string" ? value : value?.zh || value?.en);
      experts.push({
        ...manifest,
        agentName,
        ...(isTeam && Array.isArray(manifest.members) ? { members: manifest.members.map(member =>
          member && typeof member === "object" && !Array.isArray(member)
            ? { ...member, id: teamMemberId(member) } : member) } : {}),
        createdBySession,
        id: "custom-expert:" + manifest.name,
        name: localized(manifest.displayName) || manifest.name,
        description: localized(manifest.displayDescription) || manifest.description || "",
        systemPrompt: prompt,
        source: "local-expert-package",
        isCustomExpert: true,
        expertRootDir: root,
        marketplace: "my-experts",
        plugin: null,
        declaredPlugin: manifest.plugin || manifest.name,
        runtimeAvailable: !isTeam,
        nativePluginRuntimeAvailable: false,
      });
    } catch (error) {
      errors.push({ directory: entry.name, message: error.message });
    }
  }
  return { experts, errors };
}
async function clearCustomExpertSessionMarker(configDir, expertId) {
  const name = String(expertId || "").replace(/^custom-expert:/, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return;
  const scanned = await scanCustomExperts(configDir);
  const expert = scanned.experts.find((item) => item.id === "custom-expert:" + name);
  if (!expert) return;
  try {
    await fs.unlink(path.join(expert.expertRootDir, ".created-by-session"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function archiveCustomExpert(configDir, expertId) {
  const scanned = await scanCustomExperts(configDir);
  const expert = scanned.experts.find((item) => item.id === expertId);
  if (!expert) throw Error("Local expert package unavailable");
  const trash = path.join(configDir, "expert-trash");
  await fs.mkdir(trash, { recursive: true, mode: 0o700 });
  const configRoot = await fs.realpath(configDir),
    trashRoot = await fs.realpath(trash);
  if (!trashRoot.startsWith(configRoot + path.sep))
    throw Error("Expert archive escapes config root");
  const archivedPath = path.join(trash, path.basename(expert.expertRootDir) + "-" + randomUUID());
  await fs.rename(expert.expertRootDir, archivedPath);
  return { archivedPath, previousPath: expert.expertRootDir };
}
async function installCustomExpertZip(configDir, filename, overwrite = false) {
  const files = await require("./expert-zip.cjs").readExpertZip(filename);
  const manifest = require("./expert-zip.cjs").normalizeExpertManifest(
    JSON.parse(files.get(expertManifestPath(files)).toString("utf8")),
  );
  files.set(expertManifestPath(files), Buffer.from(JSON.stringify(manifest, null, 2)));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name || "")) throw Error("Invalid expert name");
  const staging = path.join(configDir, "import-staging", randomUUID());
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const stagingRoot = await fs.realpath(staging),
    configRoot = await fs.realpath(configDir);
  if (!stagingRoot.startsWith(configRoot + path.sep))
    throw Error("Expert staging escapes config root");
  const staged = path.join(staging, "plugins/marketplaces/my-experts/plugins", manifest.name);
  for (const [relative, content] of files) {
    const file = path.join(staged, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, content, { mode: 0o600, flag: "wx" });
  }
  const validated = await scanCustomExperts(staging);
  if (validated.experts.length !== 1)
    throw Error(validated.errors[0]?.message || "Invalid expert package");
  const parent = path.join(configDir, "plugins/marketplaces/my-experts/plugins");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const realConfig = await fs.realpath(configDir),
    realParent = await fs.realpath(parent);
  if (!realParent.startsWith(realConfig + path.sep))
    throw Error("Expert registry escapes config root");
  const target = path.join(parent, manifest.name);
  const exists = await fs.lstat(target).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists && !overwrite) throw Error("Expert already exists; overwrite confirmation required");
  let archived;
  if (exists) archived = await archiveCustomExpert(configDir, "custom-expert:" + manifest.name);
  try {
    await fs.rename(staged, target);
  } catch (error) {
    if (archived) await fs.rename(archived.archivedPath, archived.previousPath);
    throw error;
  }
  return { success: true, expertId: "custom-expert:" + manifest.name, localPath: target };
}
async function collectPackageFiles(rootDir) {
  const files = new Map();
  let total = 0;
  const collect = async (directory, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", ".created-by-session"].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name),
        relative = prefix + entry.name;
      if (entry.isDirectory()) await collect(filename, relative + "/");
      else if (entry.isFile()) {
        const stat = await fs.stat(filename);
        total += stat.size;
        if (stat.size > 20 * 1024 * 1024 || total > 50 * 1024 * 1024 || files.size >= 2000)
          throw Error("Package export size limit exceeded");
        files.set(relative, await fs.readFile(filename));
      } else throw Error("Package export forbids links and special files");
    }
  };
  await collect(rootDir);
  return files;
}
async function exportCustomExpert(configDir, expertId, shareAuthorName) {
  const expert = (await scanCustomExperts(configDir)).experts.find((item) => item.id === expertId);
  if (!expert) throw Error("Local expert package unavailable");
  const files = await collectPackageFiles(expert.expertRootDir);
  if (shareAuthorName !== undefined) {
    if (typeof shareAuthorName !== "string" || shareAuthorName.length > 1000)
      throw Error("Invalid share author name");
    const manifest = JSON.parse(files.get(expertManifestPath(files)).toString("utf8"));
    manifest.author = { name: shareAuthorName };
    files.set(expertManifestPath(files), Buffer.from(JSON.stringify(manifest, null, 2)));
  }
  const exportsDir = path.join(configDir, "exports");
  await fs.mkdir(exportsDir, { recursive: true, mode: 0o700 });
  if (!(await fs.realpath(exportsDir)).startsWith((await fs.realpath(configDir)) + path.sep))
    throw Error("Expert exports escape config root");
  const zipPath = path.join(
    exportsDir,
    path.basename(expert.expertRootDir) + "-" + randomUUID() + ".zip",
  );
  await fs.writeFile(zipPath, require("./expert-zip.cjs").createExpertZip(files), {
    mode: 0o600,
    flag: "wx",
  });
  return { success: true, zipPath };
}
function prepareCustomExpert(args) {
  if (!args || typeof args !== "object" || typeof args.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) || args.name.length > 64)
    throw Error("Expert name must be a lowercase slug under 65 characters");
  for (const [key, limit] of [["displayName", 256], ["description", 2000], ["instructions", 90000]])
    if (typeof args[key] !== "string" || !args[key].trim() || Buffer.byteLength(args[key], "utf8") > limit)
      throw Error("Invalid expert " + key);
  if (args.expertType !== undefined && !["agent", "team"].includes(args.expertType))
    throw Error("Invalid expert type");
  const isTeam = args.expertType === "team";
  const agents = new Map([["agents/main.md", Buffer.from(args.instructions)]]);
  let members;
  if (isTeam) {
    if (!Array.isArray(args.members) || args.members.length < 2 || args.members.length > 20)
      throw Error("Team must contain 2 to 20 members including main");
    const ids = new Set();
    members = args.members.map(member => {
      if (!member || typeof member.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(member.id) || member.id.length > 64 || ids.has(member.id))
        throw Error("Invalid or duplicate team member id");
      ids.add(member.id);
      for (const key of ["name", "profession"])
        if (typeof member[key] !== "string" || !member[key].trim() || Buffer.byteLength(member[key]) > 256)
          throw Error("Invalid team member " + key);
      if (member.id !== "main" || member.instructions !== undefined) {
        if (typeof member.instructions !== "string" || !member.instructions.trim() || Buffer.byteLength(member.instructions) > 90000)
          throw Error("Invalid team member instructions");
        agents.set("agents/" + member.id + ".md", Buffer.from(member.instructions));
      }
      return { id: member.id, name: member.name, profession: member.profession,
        ...(member.id === "main" ? { role: "lead" } : {}) };
    });
    if (!ids.has("main")) throw Error("Team must include its main lead member");
  } else if (args.members !== undefined) throw Error("Members require team expert type");
  return new Map([
    [".codebuddy-plugin/plugin.json", Buffer.from(JSON.stringify({
      name: args.name, agentName: "main", expertType: isTeam ? "team" : "agent", version: "1.0.0",
      displayName: args.displayName, displayDescription: args.description,
      ...(isTeam ? { teamInfo: { leadAgent: "main" }, members } : {}),
    }, null, 2))],
    ...agents,
  ]);
}
async function createCustomExpert(configDir, args) {
  const files = prepareCustomExpert(args);
  const draftDir = path.join(configDir, "creation-drafts");
  await fs.mkdir(draftDir, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(configDir), realDraft = await fs.realpath(draftDir);
  if (!realDraft.startsWith(root + path.sep)) throw Error("Expert draft escapes config root");
  const filename = path.join(realDraft, args.name + "-" + randomUUID() + ".zip");
  await fs.writeFile(filename, require("./expert-zip.cjs").createExpertZip(files), { flag: "wx", mode: 0o600 });
  return installCustomExpertZip(configDir, filename, false);
}
module.exports = {
  teamMemberId,
  prepareCustomExpert,
  createCustomExpert,
  collectPackageFiles,
  clearCustomExpertSessionMarker,
  scanCustomExperts,
  archiveCustomExpert,
  installCustomExpertZip,
  exportCustomExpert,
};
