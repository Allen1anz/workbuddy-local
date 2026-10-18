import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { skillFlags, skillTextMetadata, skillInvocationChanges } from "../desktop/skill-metadata.cjs";
import { resolveExpertSwitch } from "../desktop/expert-switch.cjs";
import { workspaceRuntimePath } from "../tools/runtime-path.mjs";
import { validateCalendarSchedule, nextCalendarRun } from "../tools/calendar-schedule.mjs";
import { adaptRendererCapabilities } from "./renderer-capabilities.mjs";
import { readDshConfiguration, runDshTurn } from "../tools/dsh-runtime.mjs";
import { perceiveMedia } from "../tools/local-media.mjs";
import { mediaParts } from "../desktop/media-input.cjs";
const uid = () => randomUUID(),
  now = () => new Date().toISOString();
const defs = [
  [
    "skill_invoke",
    "Load complete instructions for an enabled skill from the available skill catalog",
    { skillId: { type: "string" } },
  ],
  [
    "skill_resource_read",
    "Read a UTF-8 reference from a selected installed skill package",
    { skillId: { type: "string" }, path: { type: "string" } },
  ],
  [
    "skill_instructions_save",
    "Save SKILL.md for an explicitly selected installed local skill; requires approval. Copy revision from skill_instructions_read into expectedRevision to prevent overwriting newer edits. Preserve unrelated fields. Legacy expectedContent is also supported.",
    { skillId: { type: "string" }, expectedRevision: { type: "string" }, expectedContent: { type: "string" }, content: { type: "string" } },
  ],
  ["skill_instructions_create", "Create and register a new local plaintext skill. Requires selected skill-creator, craft mode and approval. No scripts or security scan. Never replaces an existing skill. Use a lowercase name slug, description and complete instructions.", { name: {type:"string"}, description: {type:"string"}, instructions: {type:"string"} }],
  ["skill_instructions_read", "Read the selected installed local skill SKILL.md and its revision for editing", { skillId: { type: "string" } }],
  ["workspace_list", "List files in the selected workspace", { path: { type: "string" } }],
  ["workspace_read", "Read a UTF-8 file", { path: { type: "string" } }],
  [
    "expert_resource_read",
    "Read a UTF-8 reference relative to the selected local expert package",
    { path: { type: "string" } },
  ],
  ["expert_package_create", "Create and register a local expert or team. Requires selected expert-manager, craft mode and approval. Never overwrites existing packages. For expertType=team, provide 2-20 members including id=main, each with id, name and profession. Every non-main member needs instructions. A main member's explicit instructions take precedence over top-level instructions, which are the lead fallback. Never put creation-process descriptions in role instructions. Team execution is unavailable until DSH integration.", {
    name: {type:"string"}, displayName: {type:"string"}, description: {type:"string"}, instructions: {type:"string"},
    expertType: {type:"string",enum:["agent","team"]},
    members: {type:"array",minItems:2,maxItems:20,items:{type:"object",properties:{id:{type:"string"},name:{type:"string"},profession:{type:"string"},instructions:{type:"string"}},required:["id","name","profession"],additionalProperties:false}},
  }],
  ["expert_package_read", "First read .codebuddy-plugin/plugin.json to inspect the selected expert. Card description/简介 is displayDescription in that JSON, not agents/main.md. Read agents/*.md only for requested instruction edits. Paths are package-relative.", { path: { type: "string" } }],
  ["expert_package_save", "Save an explicitly requested expert change; requires approval. For card description/简介 edits use path=.codebuddy-plugin/plugin.json and complete JSON with only displayDescription changed. Never replace agents/*.md for metadata edits. Pass expectedRevision from expert_package_read unchanged; preserve identity and unrelated fields.", { path: { type: "string" }, expectedRevision: { type: "string" }, expectedContent: { type: "string" }, content: { type: "string" } }],
  [
    "workspace_write",
    "Write a UTF-8 file; requires approval",
    { path: { type: "string" }, content: { type: "string" } },
  ],
  ["workspace_search", "Search text in workspace files", { query: { type: "string" } }],
  [
    "shell_execute",
    "Execute a shell command in workspace; requires approval",
    { command: { type: "string" } },
  ],
].map(([name, description, properties]) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: name === "workspace_list" ? [] : name === "expert_package_create" ? ["name", "displayName", "description", "instructions"] : name === "expert_package_save" ? ["path", "expectedRevision", "content"] : name === "skill_instructions_save" ? ["skillId", "content"] : Object.keys(properties),
      additionalProperties: false,
    },
  },
}));
export function createAppServer({
  dataDir,
  staticDir,
  staticFallback = false,
  extraTools = [],
  extraRoutes,
  initialSkills = [],
} = {}) {
  if (!dataDir) throw Error("dataDir required");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const privateRoot = realpathSync(dataDir);
  const isPrivate = (p) => p === privateRoot || p.startsWith(privateRoot + path.sep);
  const db = new DatabaseSync(path.join(dataDir, "workbuddy.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS entities(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,createdAt TEXT);",
  );
  chmodSync(path.join(dataDir, "workbuddy.sqlite"), 0o600);
  const pending = new Map(),
    active = new Map();
  const packageWrites = new Map();
  let skillCreations = Promise.resolve();
  function savePackageText(filename, args, label) {
    const previous = packageWrites.get(filename) || Promise.resolve();
    const operation = previous.then(async () => {
      const current = await fs.readFile(filename, "utf8");
      const matches = typeof args.expectedRevision === "string"
        ? createHash("sha256").update(current).digest("hex") === args.expectedRevision
        : current === args.expectedContent;
      if (!matches) throw Error(label + " changed; read current content before saving again");
      const temporary = filename + "." + uid() + ".tmp";
      await fs.writeFile(temporary, args.content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
      return current;
    });
    const settled = operation.catch(() => {});
    packageWrites.set(filename, settled);
    settled.then(() => { if (packageWrites.get(filename) === settled) packageWrites.delete(filename); });
    return operation;
  }
  const getConfig = () =>
    JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key='config'").get()?.value ||
        '{"baseURL":"http://127.0.0.1:11434/v1","model":"","workspace":""}',
    );
  const saveConfig = (c) =>
    db.prepare("INSERT OR REPLACE INTO settings VALUES('config',?)").run(JSON.stringify(c));
  const list = (k) =>
    db
      .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid DESC")
      .all(k)
      .map((x) => JSON.parse(x.data));
  const get = (k, id) => {
    if (!id) return null;
    let r = db.prepare("SELECT data FROM entities WHERE kind=? AND id=?").get(k, id);
    return r ? JSON.parse(r.data) : null;
  };
  const put = (k, o) => {
    db.prepare("INSERT OR REPLACE INTO entities VALUES(?,?,?)").run(k, o.id, JSON.stringify(o));
    return o;
  };
  for (const skill of initialSkills) {
    if (!get("skills", skill.id)) put("skills", { ...skill, createdAt: now(), updatedAt: now() });
  }
  const messages = (id) =>
    db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY rowid").all(id).map(message => {
      const media = get("messageMedia", message.id)?.media;
      return media ? { ...message, media } : message;
    });
  const add = (id, role, content) => {
    const m = { id: uid(), session_id: id, role, content, createdAt: now() };
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(m.id, id, role, content, m.createdAt);
    return m;
  };
  async function safePath(root, input = ".", write = false) {
    if (!root) throw Error("Select a workspace first");
    const base = await fs.realpath(root),
      target = path.resolve(base, input);
    const inside = (p) => p === base || p.startsWith(base + path.sep);
    if (!inside(target)) throw Error("Path escapes workspace");
    if (isPrivate(target))
      throw Error("Application private data directory is not accessible to workspace tools");
    let probe = target;
    while (true) {
      try {
        const actual = await fs.realpath(probe);
        if (!inside(actual)) throw Error("Symlink escapes workspace");
        if (isPrivate(actual))
          throw Error("Application private data directory is not accessible to workspace tools");
        break;
      } catch (e) {
        if (e.code !== "ENOENT" || !write) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) throw e;
        probe = parent;
      }
    }
    return target;
  }
  async function approve(name, args, emit, signal, sessionId) {
    const id = uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(false);
      }, 120000);
      const abort = () => {
        clearTimeout(timer);
        pending.delete(id);
        reject(Error("Cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        id,
        sessionId,
        name,
        args,
        createdAt: now(),
        resolve: (decision) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          pending.delete(id);
          resolve(decision);
        },
      });
      emit("approval", { id, sessionId, name, args });
    });
  }
  async function loadLocalSkill(skill, config) {
    const root = await fs.realpath(skill.localRootDir),
      allowed = await fs.realpath(path.join(dataDir, "skills"));
    if (!root.startsWith(allowed + path.sep))
      throw Error("Skill package escapes installed skills root");
    const instructions = await fs.realpath(path.join(root, "SKILL.md"));
    if (!instructions.startsWith(root + path.sep)) throw Error("Skill instructions escape package");
    const stat = await fs.stat(instructions);
    if (!stat.isFile() || stat.size > 1000000)
      throw Error("Skill instructions must be a file under 1 MB");
    skill.content = await fs.readFile(instructions, "utf8");
    if (!skill.content.trim()) throw Error("Skill instructions are empty");
    config.localSkillRoots[skill.id] = root;
  }
  async function tool(name, args, config, emit, signal, mode, sessionId) {
    if (name === "skill_instructions_read") {
      if (!config.selectedSkillIds?.includes(args.skillId)) throw Error("Select an installed local skill before editing its instructions");
      const skill = get("skills", args.skillId);
      if (!skill?.localRootDir) throw Error("Installed local skill package unavailable");
      await loadLocalSkill(skill, config);
      return { content: skill.content, revision: createHash("sha256").update(skill.content).digest("hex") };
    }
    if (name === "skill_invoke") {
      const skill = config.autoSkills?.find((skill) => skill.id === args.skillId);
      if (!skill) throw Error("Skill is not available for automatic invocation");
      if (skill.localRootDir) await loadLocalSkill(skill, config);
      return {
        skillId: skill.id,
        instructions: skill.content,
        ...(skill.localRootDir
          ? { references: "Use skill_resource_read with this skillId and package-relative paths." }
          : {}),
      };
    }
    if (name === "skill_resource_read") {
      const root = config.localSkillRoots?.[args.skillId];
      if (!root) throw Error("Select an installed skill package first");
      if (typeof args.path !== "string" || !args.path || path.isAbsolute(args.path))
        throw Error("Skill resource path must be relative");
      const base = await fs.realpath(root),
        target = path.resolve(base, args.path);
      if (!target.startsWith(base + path.sep)) throw Error("Path escapes skill package");
      const filename = await fs.realpath(target);
      if (!filename.startsWith(base + path.sep)) throw Error("Path escapes skill package");
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 100000)
        throw Error("Skill reference must be a file under 100000 bytes");
      return fs.readFile(filename, "utf8");
    }
    if (name === "expert_resource_read") {
      if (!config.localExpertRoot) throw Error("Select an installed local expert first");
      if (typeof args.path !== "string" || !args.path || path.isAbsolute(args.path))
        throw Error("Expert resource path must be relative");
      const filename = await safePath(config.localExpertRoot, args.path, false);
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 100000)
        throw Error("Expert reference must be a file under 100000 bytes");
      return fs.readFile(filename, "utf8");
    }
    const extension = extraTools.find((x) => x.definition.function.name === name);
    let expertFilename, expertRelativePath;
    if (["expert_package_read", "expert_package_save"].includes(name)) {
      const expert = config.editableExpert;
      if (!expert) throw Error("Select a local expert with expert-manager before editing its package");
      const prefix = "plugins/marketplaces/my-experts/plugins/" + expert.id.replace(/^custom-expert:/, "") + "/";
      expertRelativePath = typeof args.path === "string" && args.path.startsWith(prefix) ? args.path.slice(prefix.length) : args.path;
      const memberIds = expert.expertType === "team" && Array.isArray(expert.members)
        ? expert.members.map(member => member?.id).filter(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64)
        : [];
      const allowed = [".codebuddy-plugin/plugin.json", ".workbuddy-plugin/plugin.json", ...new Set([expert.agentName, ...memberIds].map(id => "agents/" + id + ".md"))];
      if (!allowed.includes(expertRelativePath))
        throw Error("Use the selected expert package-relative path: " + allowed.join(", "));
      expertFilename = await safePath(expert.expertRootDir, expertRelativePath, false);
      if (name === "expert_package_read") {
        const content = await fs.readFile(expertFilename, "utf8");
        return { content, revision: createHash("sha256").update(content).digest("hex") };
      }
      if (typeof args.content !== "string" || !args.content.trim() || Buffer.byteLength(args.content) > 100000 || (typeof args.expectedContent !== "string" && typeof args.expectedRevision !== "string"))
        throw Error("Expert file must be nonempty text under 100000 bytes with expectedRevision or expectedContent");
      if (args.path.endsWith("plugin.json")) {
        const manifest = JSON.parse(args.content);
        const agentName = manifest.expertType === "team" ? manifest.teamInfo?.leadAgent : manifest.agentName;
        if (manifest.name !== expert.id.replace(/^custom-expert:/, "") || agentName !== expert.agentName || manifest.expertType !== expert.expertType)
          throw Error("Expert package identity, agent and type must be preserved");
      }
    }
    if (name === "skill_instructions_save") {
      if (!config.selectedSkillIds?.includes(args.skillId) || !config.localSkillRoots?.[args.skillId])
        throw Error("Select an installed local skill before editing its instructions");
      if (typeof args.content !== "string" || !args.content.trim() || Buffer.byteLength(args.content) > 1000000 || (typeof args.expectedContent !== "string" && typeof args.expectedRevision !== "string"))
        throw Error("Skill instructions must be nonempty text under 1 MB with expectedRevision or expectedContent");
    }
    if (name === "skill_instructions_create") {
      if (!config.skillCreatorSelected) throw Error("Select skill-creator to create a skill");
      if (typeof args.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) || args.name.length > 64) throw Error("Invalid skill name");
      for (const [key, limit] of [["description", 2000], ["instructions", 90000]])
        if (typeof args[key] !== "string" || !args[key].trim() || Buffer.byteLength(args[key]) > limit) throw Error("Invalid skill " + key);
      if (list("skills").some(skill => (skillTextMetadata(skill.content).name || skill.name) === args.name)) throw Error("Skill already exists; creation cannot overwrite it");
    }
    if (name === "expert_package_create") {
      if (!config.expertManagerSelected) throw Error("Select expert-manager to create an expert");
      const { prepareCustomExpert } = await import("../desktop/custom-experts.cjs");
      prepareCustomExpert(args);
    }
    if (["workspace_write", "shell_execute", "skill_instructions_save", "expert_package_save", "expert_package_create", "skill_instructions_create"].includes(name) || extension?.requiresApproval) {
      if (mode === "ask") return "Ask mode forbids write and shell tools";
      if (!(await approve(name, args, emit, signal, sessionId))) return "Permission denied by user";
    }
    if (name === "skill_instructions_create") {
      const operation = skillCreations.then(async () => {
        if (list("skills").some(skill => (skillTextMetadata(skill.content).name || skill.name) === args.name)) throw Error("Skill already exists; creation cannot overwrite it");
        const skillsRoot = path.join(dataDir, "skills");
        await fs.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
        if (!(await fs.realpath(skillsRoot)).startsWith((await fs.realpath(dataDir)) + path.sep)) throw Error("Skill installation escapes data root");
        const localRootDir = path.join(skillsRoot, uid());
        await fs.mkdir(localRootDir, { mode: 0o700 });
        const content = "---\nname: " + args.name + "\ndescription: " + JSON.stringify(args.description) + "\n---\n\n" + args.instructions + "\n";
        await fs.writeFile(path.join(localRootDir, "SKILL.md"), content, { flag: "wx", mode: 0o600 });
        const skill = put("skills", { id: uid(), name: args.name, description: args.description, content, localRootDir, enabled: true, source: "userSettings", securityScanPerformed: false, createdAt: now(), updatedAt: now() });
        return { created: true, skillId: skill.id, name: skill.name, securityScanPerformed: false };
      });
      skillCreations = operation.catch(() => {});
      return operation;
    }
    if (name === "expert_package_create") {
      const { createCustomExpert, scanCustomExperts } = await import("../desktop/custom-experts.cjs");
      const root = path.join(path.dirname(dataDir), "expert-config");
      const result = await createCustomExpert(root, args);
      const scanned = await scanCustomExperts(root);
      const created = scanned.experts.find(item => item.id === result.expertId);
      if (!created) throw Error("Created expert package failed validation");
      put("experts", { ...created, updatedAt: now() });
      return { created: true, expertId: created.id, name: created.name };
    }
    if (name === "expert_package_save") {
      const filename = await safePath(config.editableExpert.expertRootDir, expertRelativePath, false);
      if (filename !== expertFilename)
        throw Error("Expert file changed; read current content before saving again");
      await savePackageText(filename, args, "Expert file");
      const { scanCustomExperts } = await import("../desktop/custom-experts.cjs");
      const scanned = await scanCustomExperts(path.join(path.dirname(dataDir), "expert-config"));
      const updated = scanned.experts.find((item) => item.id === config.editableExpert.id);
      if (!updated) throw Error("Saved expert package failed validation");
      put("experts", { ...updated, updatedAt: now() });
      return { saved: true, expertId: updated.id, path: args.path };
    }
    if (name === "skill_instructions_save") {
      const skill = get("skills", args.skillId);
      if (!skill?.localRootDir) throw Error("Installed skill package unavailable");
      await loadLocalSkill(skill, config);
      const filename = path.join(config.localSkillRoots[args.skillId], "SKILL.md");
      const previousContent = await savePackageText(filename, args, "Skill instructions");
      put("skills", { ...skill, ...skillInvocationChanges(previousContent, args.content), content: args.content, updatedAt: now() });
      return { saved: true, skillId: skill.id };
    }
    if (extension)
      return extension.handler(args, {
        config: { ...config },
        sessionId,
        workspace: config.workspace,
        signal,
        safePath: (p, w) => safePath(config.workspace, p, w),
      });
    const root = config.workspace;
    if (name === "workspace_list")
      return (await fs.readdir(await safePath(root, args.path || "."), { withFileTypes: true }))
        .slice(0, 1000)
        .map((d) => ({ name: d.name, type: d.isDirectory() ? "directory" : "file" }));
    if (name === "workspace_read") {
      let p = await safePath(root, args.path);
      if ((await fs.stat(p)).size > 1000000) throw Error("File exceeds 1 MB limit");
      return fs.readFile(p, "utf8");
    }
    if (name === "workspace_write") {
      let p = await safePath(root, args.path, true);
      if (Buffer.byteLength(args.content) > 1000000) throw Error("File exceeds 1 MB limit");
      await fs.mkdir(path.dirname(p), { recursive: true });
      await safePath(root, args.path, true);
      await fs.writeFile(p, args.content);
      return "Written";
    }
    if (name === "workspace_search") {
      if (!args.query) throw Error("query required");
      let results = [],
        count = 0;
      async function walk(dir) {
        for (const d of await fs.readdir(dir, { withFileTypes: true })) {
          if (signal.aborted) throw Error("Cancelled");
          if (++count > 3000 || results.length >= 100) return;
          if (["node_modules", ".git"].includes(d.name) || d.isSymbolicLink()) continue;
          let p = path.join(dir, d.name);
          if (isPrivate(await fs.realpath(p))) continue;
          if (d.isDirectory()) await walk(p);
          else if (d.isFile() && (await fs.stat(p)).size < 200000) {
            const text = await fs.readFile(p, "utf8");
            text.split("\n").forEach((line, i) => {
              if (results.length < 100 && line.includes(args.query))
                results.push({
                  path: path.relative(root, p),
                  line: i + 1,
                  text: line.slice(0, 500),
                });
            });
          }
        }
      }
      await walk(await safePath(root));
      return results;
    }
    if (name === "shell_execute")
      return new Promise(async (resolve, reject) => {
        let cwd;
        try {
          cwd = await safePath(root);
        } catch (e) {
          reject(e);
          return;
        }
        const child = spawn("/bin/sh", ["-c", args.command], {
          cwd,
          env: {
            PATH: workspaceRuntimePath(config.bundledRuntime),
            HOME: cwd,
            WORKBUDDY_CONFIG_DIR: path.join(path.dirname(dataDir), "expert-config"),
            LANG: "en_US.UTF-8",
          },
          detached: true,
        });
        let output = "",
          limited = false;
        const kill = () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(kill, 30000);
        signal.addEventListener("abort", kill, { once: true });
        const collect = (b) => {
          output += b.toString();
          if (output.length > 100000) {
            output = output.slice(0, 100000);
            limited = true;
            kill();
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", kill);
          resolve({ exitCode: code, output, truncated: limited });
        });
      });
    throw Error("Unknown tool");
  }
  async function resolveModelConfig(model) {
    const config = getConfig();
    const defaultModel = config.model;
    config.model = model || config.model;
    let desktopSettings;
    try {
      desktopSettings = JSON.parse(
        await fs.readFile(path.join(dataDir, "desktop-settings.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw Error("Saved model settings are unreadable");
    }
    const savedModel = desktopSettings?.models?.find(
      (model) => model.id === String(config.model).replace(/^custom-local:/, ""),
    );
    if (
      desktopSettings &&
      !savedModel &&
      String(config.model).replace(/^custom-local:/, "") !==
        String(defaultModel).replace(/^custom-local:/, "")
    )
      throw Error("Selected model is no longer configured; choose an available model");
    if (savedModel) {
      const endpoint = new URL(savedModel.url);
      if (!["http:", "https:"].includes(endpoint.protocol))
        throw Error("Invalid saved model endpoint");
      config.model = savedModel.id;
      config.baseURL = savedModel.url.replace(/\/chat\/completions\/?$/, "");
      config.apiKey = savedModel.apiKey || "";
      config.supportsTools = savedModel.supportsToolCall !== false;
    }
    return config;
  }
  async function completeProductText(config, instruction, text) {
    if (!config.model) throw Error("Configure a model first");
    const response = await fetch(config.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}) },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: config.model, stream: false, max_tokens: 2048,
        messages: [{ role: "system", content: instruction }, { role: "user", content: text }] }),
    });
    if (!response.ok) throw Error("Model endpoint returned HTTP " + response.status);
    const result = await response.json();
    if (result.choices?.[0]?.finish_reason === "length") throw Error("Model output was truncated; original content preserved");
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw Error("Model returned empty text");
    return content.trim();
  }
  async function chat(sessionId, body, emit, signal) {
    const session = get("sessions", sessionId);
    if (!session) throw Error("Session not found");
    if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 100000)
      throw Error("Message must be nonempty and at most 100000 characters");
    const displayMessage = body.message;
    let attachments = mediaParts(body.media);
    body = { ...session, ...body };
    const mode = body.mode || "ask";
    if (!["ask", "craft"].includes(mode)) throw Error("Mode must be ask or craft");
    if (!Array.isArray(body.skillIds || [])) throw Error("skillIds must be an array");
    const config = await resolveModelConfig(body.model);
    config.workspace = session.workspace || config.workspace;
    if (!config.model) throw Error("Configure a model first");
    let mediaRuntime;
    if (attachments.length) {
      try { mediaRuntime = JSON.parse(await fs.readFile(path.join(dataDir, "media-runtime.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw Error("本地媒体识别配置无法读取。"); }
    }
    const perception = await perceiveMedia(body.media || [], body.message, mediaRuntime, signal);
    if (perception) {
      body = { ...body, message: body.message + "\n\n" + perception };
      attachments = [];
    }
    const prior =
      get("protocol", sessionId)?.messages ||
      messages(sessionId).map(({ role, content }) => ({ role, content }));
    let expert = get("experts", body.expertId);
    if (body.expertId && !expert) throw Error("Selected expert unavailable");
    if (expert?.source === "local-expert-package") {
      const { scanCustomExperts } = await import("../desktop/custom-experts.cjs");
      const scanned = await scanCustomExperts(path.join(path.dirname(dataDir), "expert-config"));
      const current = scanned.experts.find((item) => item.id === body.expertId);
      if (!current) throw Error("Local expert package unavailable");
      expert = put("experts", { ...current, updatedAt: now() });
    }
    const skills = list("skills").filter((x) => (body.skillIds || []).includes(x.id));
    config.skillCreatorSelected = skills.some(skill => skillTextMetadata(skill.content).name === "skill-creator" || skill.name === "skill-creator");
    config.expertManagerSelected = skills.some(skill => skillTextMetadata(skill.content).name === "expert-manager" || skill.name === "expert-manager");
    config.editableExpert = null;
    const editingExpertId = body.editingExpertId || session.editingExpertId;
    if (editingExpertId && skills.some((skill) => skillTextMetadata(skill.content).name === "expert-manager" || skill.name === "expert-manager")) {
      const { scanCustomExperts } = await import("../desktop/custom-experts.cjs");
      const scanned = await scanCustomExperts(path.join(path.dirname(dataDir), "expert-config"));
      config.editableExpert = scanned.experts.find((item) => item.id === editingExpertId);
      if (!config.editableExpert) throw Error("Local expert selected for editing unavailable");
    }
    for (const skillId of body.skillIds || [])
      if (!skills.some((skill) => skill.id === skillId))
        throw Error("Selected skill unavailable: " + skillId);
    config.localSkillRoots = {};
    config.selectedSkillIds = body.skillIds || [];
    config.autoSkills = list("skills").filter(
      (skill) =>
        skill.enabled !== false &&
        (skill.disableModelInvocation ?? skillFlags(skill.content).disableModelInvocation) !== true,
    );
    for (const skill of skills.filter((skill) => skill.localRootDir)) {
      await loadLocalSkill(skill, config);
    }
    config.localExpertRoot =
      expert?.source === "local-expert-package" ? expert.expertRootDir : null;
    let system =
      "You are a local workspace assistant. Be accurate and explain tool actions. File writes and shell execution require explicit user approval. Do not claim completed actions without tool evidence.";
    if (config.autoSkills.length && config.supportsTools !== false)
      system +=
        "\nAvailable skill catalog (load relevant full instructions with skill_invoke before applying a skill):\n" +
        JSON.stringify(
          config.autoSkills.map((skill) => ({
            skillId: skill.id,
            name: skill.name,
            description: String(skill.description || "").slice(0, 500),
          })),
        );
    if (mode === "ask")
      system += " Ask mode is read-only: do not request writes or shell commands.";
    if (config.skillCreatorSelected)
      system += "\nFor a requested new plaintext skill use skill_instructions_create to register it in installed skills. Requires approval; never overwrites existing skills; no security scan is performed. Do not claim installation from workspace files alone.";
    if (config.expertManagerSelected)
      system += "\nFor a requested new expert, use expert_package_create to register it in My Experts. For a requested expert team, set expertType=team and include members with id=main as lead and at least one other member. The main member may provide its own instructions, which override the top-level lead fallback; every other member needs its own instructions. Team creation registers the product package only; team execution awaits DSH integration. Do not merely write workspace files or claim installation without the tool result. The tool requires approval and cannot overwrite existing experts.";
    if (config.editableExpert)
      system += "\nExpert selected for editing: " + config.editableExpert.id + ". This ID is only an identity, never a filesystem path. To read the manifest call expert_package_read with exactly {\"path\":\".codebuddy-plugin/plugin.json\"}; if that file is absent use .workbuddy-plugin/plugin.json. For main instructions use path=agents/" + config.editableExpert.agentName + ".md. Never prefix these paths with plugins/, an expert ID, a package directory, or an absolute directory. Save requested changes to the same package-relative path with expert_package_save, passing the returned revision unchanged as expectedRevision and the complete content. These tools are already scoped to the selected package. They take path, not expertId. Writes require approval. Do not use workspace tools for expert packages.";
    if (config.editableExpert?.expertType === "team")
      system += "\nFor team member edits, read the selected team's manifest first. Resolve member IDs in order: agent_name, agent, id, name. Members with lowercase slug ids can be edited through agents/<member-id>.md using expert_package_read and expert_package_save. Only existing files of registered members are editable; preserve unrelated member instructions.";
    if (typeof body.systemPrompt === "string" && body.systemPrompt.trim())
      system += "\nConfigured session instructions:\n" + body.systemPrompt;
    if (expert)
      system += "\nExpert instructions:\n" + (expert.systemPrompt || expert.content || "");
    if (config.localExpertRoot && config.supportsTools !== false)
      system +=
        "\nRead local expert package references with expert_resource_read using package-relative paths. It cannot access files outside this expert package.";
    for (const s of skills) {
      const isCreator = (skillTextMetadata(s.content).name || s.name) === "skill-creator";
      if (config.skillCreatorSelected && !isCreator)
        system += "\nSkill editing reference: " + s.name + ", skillId=" + JSON.stringify(s.id) + ". This is source material for skill-creator, not active instructions. Read its complete file and revision with skill_instructions_read before editing; save the complete SKILL.md, including frontmatter and unchanged body, with the returned revision unchanged. Never execute the target skill while editing it.";
      else system += "\nSkill " + s.name + ":\n" + s.content;
    }
    for (const [skillId] of config.supportsTools === false
      ? []
      : Object.entries(config.localSkillRoots))
      system +=
        "\nRead this selected skill's references with skill_resource_read, skillId=" +
        JSON.stringify(skillId) +
        ", and a package-relative path. For requested edits to its SKILL.md, use skill_instructions_read then skill_instructions_save with the returned revision copied as expectedRevision; workspace tools cannot write installed packages.";
    for (const resource of [expert, ...skills].filter(Boolean))
      if (config.supportsTools !== false && resource.resourcePath?.startsWith("vendor/"))
        system += `\nBundled reference origin for ${resource.name}: ${resource.resourcePath}. Use bundled_resource_read for relative references. External vendor tools are available only if present in the actual tool list; do not claim execution of unavailable tools.`;
    for (const m of list("memories")) system += "\nUser memory: " + m.content;
    if (config.editableExpert)
      system += "\nSelected expert editing contract (applies to the skill workflow above): first read the manifest with expert_package_read, path=.codebuddy-plugin/plugin.json (or .workbuddy-plugin/plugin.json if absent). All tool paths are relative to the already selected package; do not include its ID or directory. 用户要求修改简介、介绍、说明、描述时，修改清单中的 displayDescription；如果原清单只有 description，则修改 description。名称对应 displayName。These are card metadata, not agent instructions. For metadata-only requests, preserve every other manifest field and do not save any agents/*.md file. Only edit member instructions when the user explicitly requests their behavior or instruction changes. Save the complete manifest with expert_package_save and the revision returned by its read as expectedRevision.";
    if (config.supportsTools === false)
      system +=
        "\nThis selected model has tool execution disabled. Do not claim file reads, skill loading or other tool actions; use only the supplied text context.";
    const conversation = [
      { role: "system", content: system },
      ...prior,
      { role: "user", content: attachments.length ? [{ type: "text", text: body.message }, ...attachments] : body.message },
    ];
    if (system.length > 500000 || JSON.stringify(conversation).length > 10000000)
      throw Error(
        "Context exceeds local 10 MB limit; start a new session or reduce skills/memories",
      );
    put("sessions", {
      ...session,
      mode,
      expertId: body.expertId,
      editingExpertId: config.editableExpert?.id,
      skillIds: body.skillIds || [],
      model: config.model,
      workspace: config.workspace,
    });
    const userMessage = add(sessionId, "user", displayMessage);
    if (body.media?.length) put("messageMedia", { id: userMessage.id, media: body.media.map(({type, mimeType, data}) => ({type, mimeType, data})) });
    put("protocol", { id: sessionId, messages: conversation.slice(1) });
    let final = "";
    const captureModelUsage = (packet) => {
      const usage = packet?.usage;
      if (!usage || typeof usage !== "object") return;
      const reported = {};
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"])
        if (Number.isInteger(usage[key]) && usage[key] >= 0) reported[key] = usage[key];
      if (!Object.keys(reported).length) return;
      const modelUsage = { model: config.model, ...reported, updatedAt: now(), source: "model-response" };
      put("sessions", { ...get("sessions", sessionId), modelUsage });
      emit("model_usage", modelUsage);
    };
    const dsh = await readDshConfiguration(dataDir);
    // Existing conversations retain their engine and history; new ones opt into DSH.
    if (dsh && (session.runtimeEngine === "dsh" || prior.length === 0)) {
      put("sessions", { ...get("sessions", sessionId), runtimeEngine: "dsh" });
      const skillAliases = new Map(skills.filter(skill => /^[a-zA-Z0-9_-]{1,64}$/.test(skill.name) && !defs.some(def => def.function.name === skill.name)).map(skill => [skill.name, skill.id]));
      const dshTools = [...defs, ...[...skillAliases.keys()].map(name => ({ type: "function", function: { name,
        description: "Load the explicitly selected skill's instructions, then follow them. " + name,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } }))];
      let streamed = "";
      const result = await runDshTurn({ ...dsh, dataDir, sessionId, workspace: config.workspace || dataDir,
        model: config.model, baseURL: config.baseURL, apiKey: config.apiKey,
        system: system + "\nThe selected Skill sections above already contain their full instructions: apply those instructions directly. Only call declared function names. A selected skill's named loader returns its instructions; it is not an external executable. Never search the workspace to locate installed skills.",
        message: body.message, signal, tools: config.supportsTools === false ? [] : dshTools,
        async executeTool(name, args, toolSignal) {
          if (skillAliases.has(name)) { args = { skillId: skillAliases.get(name) }; name = "skill_invoke"; }
          const toolCallId = uid();
          emit("tool", { name, args, toolCallId });
          let value;
          try { value = await tool(name, args, config, emit, toolSignal, mode, sessionId); }
          catch (error) { if (toolSignal.aborted) throw error; value = { error: error.message }; }
          emit("tool_result", { name, result: value, toolCallId });
          return value;
        },
        onEvent(notification) {
          if (notification.method === "workbuddy/text" && notification.params.sessionId === sessionId && typeof notification.params.text === "string") {
            streamed += notification.params.text;
            if (streamed.length > 1_000_000) throw Error("DSH output exceeds 1 MB");
            emit("delta", { text: notification.params.text });
          }
          if (notification.method === "session.event") {
            const event = notification.params.event;
            put("dshEvents", { id: sessionId + ":" + event.seq, sessionId, event });
          }
        },
      });
      const answerText = streamed || result.finalResponse;
      if (!streamed) emit("delta", { text: answerText });
      conversation.push({ role: "assistant", content: answerText });
      put("protocol", { id: sessionId, messages: conversation.slice(1) });
      const answer = add(sessionId, "assistant", answerText);
      emit("done", { message: answer });
      return answer;
    }
    for (let round = 0; round < 12; round++) {
      const response = await fetch(config.baseURL.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: conversation,
          stream: true,
          ...(config.supportsTools === false
            ? {}
            : {
                tools: [
                  ...defs.filter(
                    (d) =>
                      (d.function.name !== "expert_package_create" || config.expertManagerSelected) &&
                      (d.function.name !== "skill_instructions_create" || config.skillCreatorSelected) &&
                      (mode !== "ask" ||
                      !["workspace_write", "shell_execute", "skill_instructions_save", "expert_package_save", "expert_package_create", "skill_instructions_create"].includes(d.function.name)),
                  ),
                  ...extraTools
                    .filter((t) => mode !== "ask" || !t.requiresApproval)
                    .map((x) => x.definition),
                ],
              }),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok)
        throw Error(
          "Model endpoint returned HTTP " +
            response.status +
            " " +
            (await response.text()).slice(0, 500),
        );
      let text = "",
        calls = [],
        finishReason,
        buffer = "";
      const decoder = new TextDecoder();
      if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
        let packet;
        try {
          packet = await response.json();
        } catch {
          throw Error("Unsupported model response: expected SSE or JSON");
        }
        if (packet.error) throw Error(packet.error.message || JSON.stringify(packet.error));
        captureModelUsage(packet);
        const message = packet.choices?.[0]?.message;
        finishReason = packet.choices?.[0]?.finish_reason;
        if (!message) throw Error("Unsupported model JSON response: missing choices[0].message");
        text = typeof message.content === "string" ? message.content : "";
        calls = message.tool_calls || [];
        if (text) emit("delta", { text });
      } else {
        const processLine = (rawLine) => {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let packet;
          try {
            packet = JSON.parse(data);
          } catch {
            return;
          }
          if (packet.error) throw Error(packet.error.message || JSON.stringify(packet.error));
          captureModelUsage(packet);
          if (packet.choices?.[0]?.finish_reason) finishReason = packet.choices[0].finish_reason;
          const delta = packet.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            emit("delta", { text: delta.content });
          }
          for (const t of delta?.tool_calls || []) {
            const c = (calls[t.index] ||= {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            });
            if (t.id) c.id = t.id;
            if (t.function?.name) c.function.name += t.function.name;
            if (t.function?.arguments) c.function.arguments += t.function.arguments;
          }
        };
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 2000000 || text.length > 1000000)
            throw Error("Model output exceeds local size limit");
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            processLine(line);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);
      }
      if (["length", "content_filter"].includes(finishReason)) {
        if (text) {
          conversation.push({ role: "assistant", content: text });
          put("protocol", { id: sessionId, messages: conversation.slice(1) });
          add(sessionId, "assistant", "[回答未完成]\n" + final + text);
        }
        throw Error(
          finishReason === "length"
            ? "模型输出达到长度上限，回答未完成；可以继续生成。"
            : "模型服务过滤了部分输出，回答未完成。",
        );
      }
      if (!text && !calls.filter(Boolean).length)
        throw Error("Model returned no assistant content or tool calls");
      if (text.length > 1000000) throw Error("Model output exceeds 1 MB");
      if (config.supportsTools === false && calls.some(Boolean))
        throw Error(
          "Selected model has tool execution disabled; returned tool calls were not executed",
        );
      final += text;

      if (!calls.filter(Boolean).length) {
        conversation.push({ role: "assistant", content: text });
        put("protocol", { id: sessionId, messages: conversation.slice(1) });
        const m = add(sessionId, "assistant", final);
        emit("done", { message: m });
        return m;
      }
      const roundStart = conversation.length;
      const completedCalls = [];
      conversation.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.filter(Boolean),
      });
      for (const call of calls.filter(Boolean)) {
        let result;
        const toolCallId = uid();
        let started = false;
        try {
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw Error("Tool arguments must be a JSON object");
          if (call.function.name === "skill_invoke") {
            const skill = config.autoSkills?.find((skill) => skill.id === args.skillId);
            if (skill) args.skill = skill.name;
          }
          emit("tool", { name: call.function.name, args, toolCallId });
          started = true;
          result = await tool(call.function.name, args, config, emit, signal, mode, sessionId);
        } catch (e) {
          if (signal.aborted) throw e;
          if (!started) emit("tool", { name: call.function.name, args: {}, toolCallId });
          result = { error: e.message };
        }
        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        completedCalls.push(call);
        put("protocol", {
          id: sessionId,
          messages: [
            ...conversation.slice(1, roundStart),
            { role: "assistant", content: text || null, tool_calls: [...completedCalls] },
            ...conversation.slice(roundStart + 1),
          ],
        });
        emit("tool_result", { name: call.function.name, result, toolCallId });
      }
    }
    throw Error("Agent reached 12 tool rounds; start another message to continue");
  }

  for (const run of list("runs")) {
    if (["running", "awaiting_approval"].includes(run.status)) {
      put("runs", { ...run, status: "interrupted", finishedAt: now() });
      const session = run.sessionId ? get("sessions", run.sessionId) : null;
      if (session && session.status !== "archived")
        put("sessions", {
          ...session,
          status: "interrupted",
          pendingInputKind: null,
          updatedAt: now(),
        });
    }
  }
  function startAutomation(automation, group = null) {
    if (
      !group &&
      list("runs").some(
        (r) =>
          r.automationId === automation.id && ["running", "awaiting_approval"].includes(r.status),
      )
    )
      throw Error("Automation is already running");
    if (!group && automation.cwds?.length > 1) {
      const directories = [
        ...new Set(
          automation.cwds.map((directory) => {
            if (typeof directory !== "string" || !directory)
              throw Error("Invalid automation workspace");
            const real = realpathSync(directory);
            if (!statSync(real).isDirectory())
              throw Error("Automation workspace must be a directory");
            return real;
          }),
        ),
      ];
      const groupId = uid();
      const runs = directories.map((workspace, index) =>
        startAutomation({ ...automation, cwds: [], workspace }, { id: groupId, index }),
      );
      return { ...runs[0], runs, groupId };
    }
    let workspace = automation.workspace || getConfig().workspace;
    if (!workspace) {
      workspace = path.join(path.dirname(dataDir), "workspaces", "automation-" + uid());
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      workspace = realpathSync(workspace);
    }
    const session = put("sessions", {
      id: uid(),
      title: automation.name,
      workspace,
      createdAt: now(),
      mode: automation.mode || "ask",
      model: automation.model,
      expertId: automation.expertId,
      skillIds: automation.skillIds || [],
      status: "running",
      pendingInputKind: null,
    });
    let run = put("runs", {
      id: group?.index === 0 ? group.id : uid(),
      automationId: automation.id,
      ...(group ? { groupId: group.id } : {}),
      sessionId: session.id,
      workspace,
      status: "running",
      createdAt: now(),
    });
    const ctrl = new AbortController();
    active.set(session.id, ctrl);
    const updateSession = (status, pendingInputKind = null) =>
      put("sessions", {
        ...get("sessions", session.id),
        status,
        pendingInputKind,
        lastActivityAt: now(),
        updatedAt: now(),
      });
    const emit = (event, data) => {
      if (["tool", "approval", "tool_result"].includes(event))
        put("events", { id: uid(), sessionId: session.id, event, data, createdAt: now() });
      if (event === "approval") {
        run = put("runs", { ...run, status: "awaiting_approval", approval: data });
        updateSession("pending", "permission");
      }
      if (event === "tool_result") {
        run = put("runs", { ...run, status: "running", approval: null });
        updateSession("running");
      }
    };
    chat(
      session.id,
      {
        message: automation.prompt,
        mode: automation.mode || "ask",
        expertId: automation.expertId,
        skillIds: automation.skillIds,
        model: automation.model,
      },
      emit,
      ctrl.signal,
    )
      .then((message) => {
        updateSession("completed");
        return put("runs", {
          ...run,
          status: "completed",
          output: message.content.slice(0, 10000),
          approval: null,
          finishedAt: now(),
        });
      })
      .catch((e) => {
        const status = ctrl.signal.aborted ? "cancelled" : "failed";
        updateSession(status);
        return put("runs", {
          ...run,
          status,
          approval: null,
          error: e.message,
          finishedAt: now(),
        });
      })
      .finally(() => active.delete(session.id));
    return run;
  }
  const scheduler = setInterval(() => {
    for (const automation of list("automations")) {
      if (automation.scheduleType) {
        if (!automation.enabled || automation.status === "PAUSED") continue;
        try {
          validateCalendarSchedule(automation);
          if (!automation.nextRunAt) {
            const nextRunAt = nextCalendarRun(automation);
            put("automations", {
              ...automation,
              nextRunAt,
              ...(!nextRunAt ? { enabled: false, status: "PAUSED" } : {}),
            });
            continue;
          }
          if (Date.parse(automation.nextRunAt) > Date.now()) continue;
          startAutomation(automation);
          const nextRunAt = automation.scheduleType === "once" ? null : nextCalendarRun(automation);
          put("automations", {
            ...automation,
            nextRunAt,
            ...(!nextRunAt ? { enabled: false, status: "PAUSED" } : {}),
          });
        } catch (error) {
          if (error.message !== "Automation is already running")
            put("automations", {
              ...automation,
              enabled: false,
              status: "PAUSED",
              scheduleError: error.message,
            });
        }
        continue;
      }
      const minutes = Number(
        automation.intervalMinutes ||
          (automation.schedule === "hourly" ? 60 : automation.schedule === "daily" ? 1440 : 0),
      );
      if (!automation.enabled || !Number.isFinite(minutes) || minutes < 1) continue;
      if (!automation.nextRunAt) {
        put("automations", {
          ...automation,
          nextRunAt: new Date(Date.now() + minutes * 60000).toISOString(),
        });
        continue;
      }
      if (Date.parse(automation.nextRunAt) > Date.now()) continue;
      try {
        startAutomation(automation);
      } catch {}
      put("automations", {
        ...automation,
        nextRunAt: new Date(Date.now() + minutes * 60000).toISOString(),
      });
    }
  }, 1000);
  scheduler.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(req.url, "http://localhost"),
      segments = url.pathname.split("/").filter(Boolean);
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      for (let index = 0; index < segments.length; index++)
        segments[index] = decodeURIComponent(segments[index]);
      if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host)
        return json(403, { error: "Cross-origin requests denied" });
      if (req.headers.host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host))
        return json(403, { error: "Invalid host" });
      if (segments[0] === "expert-catalog-assets") {
        if (req.method !== "GET") return json(405, { error: "Method not allowed" });
        const root = await fs.realpath(path.resolve(import.meta.dirname, "../desktop-ui/expert-catalog-assets"));
        const candidate = path.resolve(root, ...segments.slice(1));
        if (!candidate.startsWith(root + path.sep)) return json(403, { error: "Invalid asset path" });
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(candidate).toLowerCase()];
        if (!mime) return json(404, { error: "Asset not found" });
        let filename;
        try { filename = await fs.realpath(candidate); }
        catch (error) { if (error.code === "ENOENT") return json(404, { error: "Asset not found" }); throw error; }
        if (!filename.startsWith(root + path.sep)) return json(403, { error: "Invalid asset path" });
        const image = await fs.readFile(filename);
        res.writeHead(200, { "Content-Type": mime, "Content-Length": image.byteLength, "Cache-Control": "public, max-age=3600" });
        return res.end(image);
      }
      if (req.method === "GET" && url.pathname === "/api/product/model-settings") {
        const modelSettings = JSON.parse(await fs.readFile(
          path.resolve(import.meta.dirname, "../desktop-resources/model-settings-5.8.3.json"), "utf8",
        ));
        return json(200, modelSettings);
      }
      let body = {};
      if (["POST", "PUT"].includes(req.method)) {
        let raw = "";
        for await (const c of req) {
          raw += c;
          if (raw.length > (segments[0] === "api" && segments[1] === "sessions" && segments[3] === "chat" ? 8_000_000 : 2_000_000)) throw Error("Request too large");
        }
        body = raw ? JSON.parse(raw) : {};
      }
      if (segments[0] !== "api") {
        if (!staticDir) return json(404, { error: "Not found" });
        let file = path.resolve(
          staticDir,
          "." + (url.pathname === "/" ? "/index.html" : url.pathname),
        );
        if (!file.startsWith(path.resolve(staticDir) + path.sep))
          return json(403, { error: "Invalid path" });
        let data;
        try {
          data = await fs.readFile(file);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (!staticFallback || req.method !== "GET" || path.extname(file))
            return json(404, { error: "Not found" });
          file = path.join(staticDir, "index.html");
          data = await fs.readFile(file);
        }
        let renderedData;
        try {
          renderedData = adaptRendererCapabilities(file, data);
        } catch (error) {
          return json(500, { error: "Desktop resource adaptation failed", detail: error.message });
        }
        res.writeHead(200, {
          "Content-Type":
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".woff": "font/woff",
              ".woff2": "font/woff2",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".webp": "image/webp",
            }[path.extname(file)] || "application/octet-stream",
        });
        res.end(renderedData);
        return;
      }
      if (
        extraRoutes &&
        (await extraRoutes(req, res, url, {
          body,
          dataDir,
          config: getConfig(),
          safePath: (p, w) => safePath(getConfig().workspace, p, w),
        }))
      )
        return;
      const kind = segments[1],
        id = segments[2];
      if (kind === "memory-profile" && id === "suggestion" && req.method === "POST") {
        if (typeof body.suggestion !== "string" || !body.suggestion.trim() || body.suggestion.length > 10000 || typeof body.currentMemory !== "string")
          return json(200, { success: false, accepted: false, error: "Invalid memory suggestion" });
        const before = list("memories");
        const snapshot = JSON.stringify(before);
        const current = before.map(item => item.content).join("\n\n");
        if (current !== body.currentMemory || !current.trim())
          return json(200, { success: false, accepted: false, error: "Memory changed; reopen before editing" });
        try {
          const content = await completeProductText(await resolveModelConfig(body.model),
            "Update the existing memory only according to the requested correction. Preserve unrelated facts, headings, dates and language. Do not invent facts. Return only the complete updated memory, without commentary or code fences.",
            "Existing memory:\n" + current + "\n\nRequested correction:\n" + body.suggestion);
          if (content.length > 100000) throw Error("Updated memory is too large");
          if (JSON.stringify(list("memories")) !== snapshot) throw Error("Memory changed during editing; reopen before retrying");
          db.exec("BEGIN");
          try {
            put("memoryRevisions", { id: uid(), memories: before, createdAt: now(), suggestion: body.suggestion });
            before.forEach((memory, index) => put("memories", { ...memory, content: index === 0 ? content : "", updatedAt: now() }));
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          return json(200, { success: true, accepted: true, source: "local-model", memoryBlock: content });
        } catch (error) {
          return json(200, { success: false, accepted: false, error: error.message });
        }
      }
      if (kind === "prompt" && id === "enhance" && req.method === "POST") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 100000)
          return json(200, { success: false, code: "invalid_input", error: "请输入非空提示词（最多 100000 字符）。" });
        try {
          const session = body.sessionId ? get("sessions", body.sessionId) : null;
          const config = await resolveModelConfig(body.model || session?.model);
          const text = await completeProductText(config,
            "Rewrite the user prompt to make it clear, specific, and actionable. Preserve its language, intent, constraints, and facts. Do not answer or execute it, do not invent requirements. Return only the rewritten prompt.", body.text);
          return json(200, { success: true, text });
        } catch (error) {
          return json(200, { success: false, code: "llm_error", error: error.message });
        }
      }
      if (kind === "expert-resources" && req.method === "GET") {
        const expert = get("experts", id);
        if (expert?.source !== "local-expert-package" || !expert.expertRootDir)
          return json(404, { error: "Expert resource not found" });
        const configRoot = await fs.realpath(path.join(path.dirname(dataDir), "expert-config"));
        const registry = await fs.realpath(
          path.join(configRoot, "plugins/marketplaces/my-experts/plugins"),
        );
        const root = await fs.realpath(expert.expertRootDir);
        if (!registry.startsWith(configRoot + path.sep) || !root.startsWith(registry + path.sep))
          return json(403, { error: "Expert resource root escapes registry" });
        const relative = segments.slice(3).join("/");
        const candidate = path.resolve(root, relative);
        if (!relative || !candidate.startsWith(root + path.sep))
          return json(403, { error: "Expert resource escapes package" });
        const filename = await fs.realpath(candidate);
        if (!filename.startsWith(root + path.sep))
          return json(403, { error: "Expert resource symlink escapes package" });
        const mime = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        }[path.extname(filename).toLowerCase()];
        const stat = await fs.stat(filename);
        if (!mime || !stat.isFile() || stat.size > 10 * 1024 * 1024)
          return json(403, { error: "Only package images under 10 MiB are available" });
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        res.end(await fs.readFile(filename));
        return;
      }
      if (kind === "config") {
        if (req.method === "PUT") {
          const c = getConfig();
          for (const k of ["baseURL", "model", "apiKey", "workspace"])
            if (body[k] !== undefined) c[k] = String(body[k]);
          if (body.supportsTools !== undefined) c.supportsTools = body.supportsTools !== false;
          const endpoint = new URL(c.baseURL);
          if (!["http:", "https:"].includes(endpoint.protocol))
            throw Error("Invalid endpoint protocol");
          if (c.workspace) {
            c.workspace = await fs.realpath(c.workspace);
            if (!(await fs.stat(c.workspace)).isDirectory())
              throw Error("Workspace must be directory");
          }
          saveConfig(c);
        }
        const c = getConfig();
        const { apiKey, ...publicConfig } = c;
        return json(200, { ...publicConfig, apiKeySet: !!apiKey });
      }
      if (kind === "workspaces") {
        if (req.method === "POST") {
          const workspace = await fs.realpath(body.path);
          if (!(await fs.stat(workspace)).isDirectory()) throw Error("Workspace must be directory");
          saveConfig({ ...getConfig(), workspace });
          return json(200, { path: workspace });
        }
        return json(
          200,
          [{ path: getConfig().workspace }].filter((x) => x.path),
        );
      }
      if (kind === "approvals") {
        if (req.method === "GET")
          return json(
            200,
            [...pending.values()].map(({ resolve, ...p }) => p),
          );
        const p = pending.get(id);
        if (!p) return json(404, { error: "Approval expired" });
        p.resolve(body.decision === "approve");
        return json(200, { ok: true });
      }
      if (kind === "sessions" && segments[3] === "events")
        return json(
          200,
          list("events").filter((x) => x.sessionId === id),
        );
      if (kind === "sessions" && segments[3] === "expert-switch" && req.method === "POST") {
        let switchExperts = list("experts");
        if (switchExperts.some((expert) => String(expert.id).startsWith("custom-expert:"))) {
          const { scanCustomExperts } = await import("../desktop/custom-experts.cjs");
          const scanned = await scanCustomExperts(
            path.join(path.dirname(dataDir), "expert-config"),
          );
          const available = new Set(scanned.experts.map((expert) => expert.id));
          switchExperts = switchExperts.filter(
            (expert) => !String(expert.id).startsWith("custom-expert:") || available.has(expert.id),
          );
        }
        const previous = get("sessions", id);
        if (!previous) return json(404, { error: "Session not found" });
        if (active.has(id) || ["running", "pending"].includes(previous.status))
          return json(409, { error: "Stop the active session before switching expert" });
        if (
          Object.hasOwn(body, "expectedExpertId") &&
          (previous.expertId || null) !== (body.expectedExpertId || null)
        )
          return json(409, { error: "Expert binding changed; refresh before switching" });
        const plan = resolveExpertSwitch({ ...body, sessionId: id }, previous, switchExperts);
        if (!plan) return json(200, previous);
        return json(
          200,
          put("sessions", {
            ...previous,
            expertId: plan.expertId,
            expertRuntimeIdentity: plan.runtimeIdentity,
            expertMarketplace: plan.expertMarketplace,
            modeEpoch: (previous.modeEpoch || 0) + 1,
            config: {
              ...previous.config,
              expertId: plan.expertId,
              runtimeIdentity: plan.runtimeIdentity,
              expertMarketplace: plan.expertMarketplace,
              expertPluginBinding: plan.binding,
            },
            updatedAt: now(),
          }),
        );
      }
      if (kind === "sessions" && segments[3] === "messages") return json(200, messages(id));
      if (kind === "sessions" && segments[3] === "cancel") {
        active.get(id)?.abort();
        return json(200, { ok: true });
      }
      if (kind === "sessions" && segments[3] === "chat" && req.method === "POST") {
        if (active.has(id)) return json(409, { error: "Session already running" });
        const ctrl = new AbortController();
        active.set(id, ctrl);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        const emit = (event, data) => {
          if (["tool", "approval", "tool_result"].includes(event))
            put("events", { id: uid(), sessionId: id, event, data, createdAt: now() });
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        res.on("close", () => ctrl.abort());
        try {
          await chat(id, body, emit, ctrl.signal);
        } catch (e) {
          const connectionRefused = e.message === "fetch failed" && e.cause?.code === "ECONNREFUSED";
          emit("error", { message: connectionRefused
            ? "无法连接模型服务，请检查接口地址；本地模型可能尚未启动或已暂停。"
            : e.message });
        } finally {
          active.delete(id);
          res.end();
        }
        return;
      }
      if (kind === "automations" && segments[3] === "run" && req.method === "POST") {
        const automation = get(kind, id);
        if (!automation) return json(404, { error: "Not found" });
        return json(202, startAutomation(automation));
      }
      if (["sessions", "experts", "skills", "memories", "automations", "runs"].includes(kind)) {
        if (req.method === "GET") return json(200, id ? get(kind, id) : list(kind));
        if (
          kind === "runs" &&
          ((req.method === "PUT" && body.archiveGroup === true) ||
            (req.method === "DELETE" && url.searchParams.get("inbox") === "1"))
        ) {
          const run = get("runs", id);
          if (!run) throw Error("Run not found");
          const children = run.groupId
            ? list("runs").filter((item) => item.groupId === run.groupId)
            : [run];
          if (children.some((item) => ["running", "awaiting_approval"].includes(item.status)))
            throw Error("Running records cannot be archived or deleted");
          if (req.method === "DELETE" && children.some((item) => !item.archived))
            throw Error("Archive all records before deletion");
          if (req.method === "PUT" && body.archived !== true)
            throw Error("Invalid archive operation");
          db.exec("BEGIN");
          try {
            for (const child of children) {
              if (req.method === "DELETE")
                db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run("runs", child.id);
              else
                put("runs", {
                  ...child,
                  archived: true,
                  archivedAt: body.archivedAt || now(),
                  updatedAt: now(),
                });
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return json(200, req.method === "DELETE" ? { ok: true } : get("runs", id));
        }
        if (req.method === "DELETE") {
          db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
          return json(200, { ok: true });
        }
        if (["POST", "PUT"].includes(req.method)) {
          for (const field of ["content", "systemPrompt", "prompt"])
            if (
              body[field] !== undefined &&
              (typeof body[field] !== "string" || body[field].length > 100000)
            )
              throw Error(field + " must be text at most 100000 characters");
          const old = id ? get(kind, id) : null;
          const object = {
            ...old,
            ...body,
            id: id || uid(),
            createdAt: old?.createdAt || now(),
            updatedAt: now(),
          };
          if (kind === "sessions") object.title ||= "New conversation";
          if (kind === "automations" && object.scheduleType) {
            object.scheduleAnchor ||= object.createdAt;
            object.status ||= object.enabled === false ? "PAUSED" : "ACTIVE";
            object.enabled = object.status === "ACTIVE" && body.enabled !== false;
            validateCalendarSchedule(object);
            object.nextRunAt = nextCalendarRun(object);
            delete object.scheduleError;
          }
          return json(200, put(kind, object));
        }
      }
      return json(404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) json(e.code === "ENOENT" ? 404 : 400, { error: e.message });
      else res.end();
    }
  });
  server.on("close", () => {
    clearInterval(scheduler);
    for (const ctrl of active.values()) ctrl.abort();
    for (const p of pending.values()) p.resolve(false);
    const closeDatabase = () => {
      if (active.size) {
        setTimeout(closeDatabase, 10).unref();
        return;
      }
      db.close();
    };
    closeDatabase();
  });
  return server;
}
