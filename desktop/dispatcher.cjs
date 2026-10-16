"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { createBundledPlugins } = require("./bundled-plugins.cjs");
const { testModelConnectivity } = require("./model-connectivity.cjs");
const { conversationInfo, conversationSnapshot, textRequests, requestEntries } = require("./conversation-sdk.cjs");
const { skillFlags, skillTextMetadata, skillInvocationChanges, setModelInvocationDisabled } = require("./skill-metadata.cjs");
const { mediaParts } = require("./media-input.cjs");
const messageQueueWritesByProfile = new Map();

function createDispatcher({
  origin,
  dataDir,
  emit = () => {},
  fetchImpl = globalThis.fetch,
  homeDir = require("node:os").homedir(),
  openPath,
  app,
  publicExpertCatalog = false,
} = {}) {
  if (!origin || !dataDir) throw new Error("Local origin and dataDir required");
  const configFile = path.join(dataDir, "desktop-settings.json");
  let ready, settings, seedReady;
  let skillsFingerprint = "", skillsVersion = Date.now();
  async function loadSettings() {
    if (!ready)
      ready = (async () => {
        await fs.mkdir(dataDir, { recursive: true });
        try {
          settings = JSON.parse(await fs.readFile(configFile, "utf8"));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          settings = {
            account: { uid: "local:" + randomUUID(), nickname: "本地用户", isLocal: true },
            values: { personalization: { enabled: true } },
            models: [],
            activePlugins: [],
            expertHistory: [],
          };
          await fs.writeFile(configFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
        }
      })();
    await ready;
    return settings;
  }
  let settingsWrites = Promise.resolve();
  let personalizationWrites = Promise.resolve();
  let activeExpertMutations = Promise.resolve();
  function updateActiveExperts(change) {
    const operation = activeExpertMutations.then(async () => {
      const previous = settings.activePlugins;
      settings.activePlugins = change(previous);
      try {
        await persist();
      } catch (error) {
        settings.activePlugins = previous;
        throw error;
      }
    });
    activeExpertMutations = operation.catch(() => {});
    return operation;
  }
  function persist() {
    const snapshot = JSON.stringify(settings, null, 2);
    const operation = settingsWrites.then(async () => {
      const temporary = configFile + "." + randomUUID() + ".tmp";
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, configFile);
    });
    settingsWrites = operation.catch(() => {});
    return operation;
  }
  async function saveModels(nextModels, updateBackend) {
    const previousModels = settings.models;
    settings.models = nextModels;
    try {
      await persist();
    } catch (error) {
      settings.models = previousModels;
      throw error;
    }
    try {
      await updateBackend();
    } catch (error) {
      settings.models = previousModels;
      await persist();
      throw error;
    }
  }
  async function rest(route, method = "GET", body) {
    const response = await fetchImpl(origin + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "Local backend HTTP " + response.status);
      error.code = "LOCAL_BACKEND_ERROR";
      throw error;
    }
    return result;
  }

  async function ensureSeed() {
    if (settings.resourcesSeeded) return;
    if (!seedReady)
      seedReady = (async () => {
        let seed;
        try {
          seed = JSON.parse(
            await fs.readFile(path.join(__dirname, "../desktop-resources/seed.json"), "utf8"),
          );
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        for (const kind of ["skills", "experts"]) {
          const existing = await rest("/" + kind),
            ids = new Set(existing.map((item) => item.id));
          for (const item of seed[kind] || [])
            if (!ids.has(item.id))
              await rest("/" + kind + "/" + encodeURIComponent(item.id), "PUT", item);
        }
        settings.resourcesSeeded = true;
        await persist();
      })().catch((error) => {
        seedReady = null;
        throw error;
      });
    await seedReady;
  }
  const bundledPlugins = createBundledPlugins({
    dataDir,
    applySkillChanges: async (changes) => {
      await ensureSeed();
      const skills = await rest("/skills"),
        previous = [];
      try {
        for (const change of changes) {
          const skill = skills.find((item) => item.id === change.id);
          if (!skill) throw Error("Missing bundled child skill: " + change.id);
          await rest("/skills/" + encodeURIComponent(skill.id), "PUT", {
            ...skill,
            enabled: change.enabled,
          });
          previous.push(skill);
        }
      } catch (error) {
        for (const skill of previous.reverse())
          await rest("/skills/" + encodeURIComponent(skill.id), "PUT", skill);
        throw error;
      }
      emit("plugin:changed", {});
    },
  });
  function unsupported(channel) {
    const error = new Error("本地版本尚未实现此能力：" + channel);
    error.code = "LOCAL_CAPABILITY_UNAVAILABLE";
    throw error;
  }
  function sessionSummary(session) {
    return {
      ...session,
      name: session.title,
      cwd: session.workspace,
      userId: settings.account?.uid,
      status:
        !session.status ||
        session.status === "idle" ||
        (session.status === "pending" &&
          !session.pendingInputKind &&
          !activePrompts.has(session.id))
          ? "completed"
          : session.status,
      pendingInputKind: session.pendingInputKind || null,
      config: {
        ...session.config,
        mode: session.mode || "craft",
        model: session.model,
        expertId: session.expertId,
        permissionMode: "default",
        useSandboxCLI: false,
      },
      updatedAt: session.updatedAt || session.createdAt,
      pinned: (settings.pinnedSessionIds || []).includes(session.id),
    };
  }
  function canonicalSkillName(skill) {
    return skillTextMetadata(skill.content).name || skill.slug || skill.name || skill.id;
  }

  function resolveSkill(skills, reference) {
    const exactId = String(reference).replace(/^local-skill:/, "");
    const exact = skills.filter(
      (skill) => skill.id === exactId || skillSummary(skill).filePath === reference,
    );
    const matches = exact.length
      ? exact
      : skills.filter((skill) =>
          [canonicalSkillName(skill), skill.name, skill.slug].includes(reference),
        );
    if (!matches.length) {
      const error = new Error("找不到所选技能：" + reference);
      error.code = "LOCAL_SKILL_NOT_FOUND";
      throw error;
    }
    if (matches.length !== 1) {
      const error = new Error(
        "技能名称重复，无法确定所选版本：" + reference + "。请为重复项使用不同名称。",
      );
      error.code = "LOCAL_SKILL_AMBIGUOUS";
      throw error;
    }
    return matches[0];
  }
  function skillSummary(skill) {
    return {
      ...skill,
      name: canonicalSkillName(skill),
      displayName: skill.name,
      provenance: skill.source || "userSettings",
      description:
        skillTextMetadata(skill.content).description ||
        skill.description ||
        skill.content?.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").split("\n").find((line) => line.trim() && !line.startsWith("#")) ||
        "",
      filePath: skill.localRootDir
        ? path.join(skill.localRootDir, "SKILL.md")
        : skill.resourcePath
          ? path.join(__dirname, "../desktop-resources", skill.resourcePath)
          : "local-skill:" + skill.id,
      source: ["userSettings", "builtin", "plugin", "connector"].includes(skill.source)
        ? skill.source
        : "userSettings",
      enabled: skill.enabled !== false,
      disableModelInvocation:
        skill.disableModelInvocation ??
        skillFlags(skill.content).disableModelInvocation ??
        skill.enabled === false,
      userInvocable: skill.userInvocable ?? skillFlags(skill.content).userInvocable ?? true,
    };
  }
  function expertSummary(expert) {
    if (expert.source === "public-expert-catalog")
      expert = require("./expert-catalog.cjs").localExpert(expert, origin);
    const localized = (value, fallback = "") => typeof value === "string"
      ? { zh: value, en: value }
      : value || { zh: fallback, en: fallback };
    const packageAvatar = (avatar) =>
      expert.source === "local-expert-package" && typeof avatar === "string" &&
      avatar && !/^(?:https?:|data:)/i.test(avatar)
        ? origin + "/api/expert-resources/" + encodeURIComponent(expert.id) + "/" +
          avatar.split("/").map(encodeURIComponent).join("/")
        : avatar;
    return {
      ...expert,
      ...(Array.isArray(expert.members) ? { members: expert.members.map(member =>
        member && typeof member === "object"
          ? { ...member, avatar: packageAvatar(member.avatar) } : member) } : {}),
      id: expert.id,
      name: expert.name,
      profession: localized(expert.profession, expert.name),
      displayName: localized(expert.displayName, expert.name),
      avatar:
        packageAvatar(expert.avatar) || "data:image/svg+xml," + encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#e6f5ef"/><circle cx="32" cy="24" r="10" fill="#25876b"/><path d="M14 53a18 18 0 0 1 36 0" fill="#25876b"/></svg>'),
      description: localized(expert.displayDescription || expert.description),
      categoryId: expert.categoryId || "local",
      prompt: {
        zh: expert.systemPrompt || expert.content || "",
        en: expert.systemPrompt || expert.content || "",
      },
      plugin: expert.plugin || null,
      updatedAt: expert.updatedAt,
      source: expert.source || "local",
      isCustom: !["bundled-client-resource", "public-expert-catalog"].includes(expert.source),
    };
  }
  function sdkExpert(expert) {
    const custom = expert.isCustom || expert.source === "local-expert-package";
    return { ...expert, name: expert.displayName || { zh: expert.name, en: expert.name },
      source: custom ? "custom" : "builtin", isCustomExpert: !!custom,
      ...(custom ? { localPath: expert.expertRootDir || expert.localPath,
        runtimeIdentity: expert.runtimeIdentity || `expert:${expert.id}:${expert.marketplace || "my-experts"}` } : {}),
      localSource: expert.source };
  }
  async function modelsResult() {
    const config = await rest("/config");
    const own = settings.models.map(({ apiKey, ...model }) => ({
      ...model,
      name:
        path.isAbsolute(model.id) && (!model.name || model.name === model.id)
          ? path.basename(model.id) + "（本地）"
          : model.name,
      apiKeySet: !!apiKey,
    }));
    if (config.model && !own.some((m) => m.id === config.model))
      own.unshift({
        id: config.model,
        name: path.isAbsolute(config.model)
          ? path.basename(config.model) + "（本地）"
          : config.model,
        url: config.baseURL,
        vendor: "OpenAI",
        supportsToolCall: config.supportsTools !== false,
        apiKeySet: config.apiKeySet,
      });
    let mediaRuntime;
    try { mediaRuntime = JSON.parse(await fs.readFile(path.join(dataDir, "media-runtime.json"), "utf8")); }
    catch { mediaRuntime = undefined; }
    if (mediaRuntime?.enabled && path.isAbsolute(mediaRuntime.visionModel || "") && path.isAbsolute(mediaRuntime.python || "")) {
      const available = await Promise.all([
        fs.access(path.join(mediaRuntime.visionModel, "config.json")), fs.access(mediaRuntime.python),
      ]).then(() => true, () => false);
      for (const model of available ? own : []) {
        let endpoint;
        try { endpoint = new URL(model.url); } catch { continue; }
        if (path.isAbsolute(model.id) && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) model.supportsImages = true;
      }
    }
    return { models: own, path: configFile };
  }
  async function productConfiguration() {
    const config = await rest("/config");
    const { models } = await modelsResult();
    return {
      deploymentType: "SaaS",
      distributionType: "independent-local",
      environmentType: "local",
      endpoint: origin,
      models: models.map((m) => ({ ...m, id: "custom-local:" + m.id })),
      availableModels: models.map((m) => "custom-local:" + m.id),
      agents: [
        {
          name: "craft",
          description: "本地执行助手",
          defaultModel: models[0] ? "custom-local:" + models[0].id : undefined,
        },
      ],
      modelGroups: [],
      links: {
        officialWebsite: "https://www.workbuddy.cn/",
        helpDocument: "https://www.workbuddy.cn/docs/workbuddy/Overview",
      },
      productFeatures: {
        ShowAboutQRCodes: true,
        ChannelWechatKf: true,
        DisableYuanbaoChannel: true,
        EnableSecurityCenter: true,
        EnableAppearance: true,
        EnableWechatShareFile: false,
        KnowledgeBase: true,
        TencentDesignX: true,
        TencentDocsKnowledge: true,
        TencentLexiangKnowledge: true,
        ImaKnowledge: true,
        Discover: true,
        Space: true,
      },
      galileo: { enabled: false },
      customModelSettings: { enabled: true },
      customModelSettingsUrl: origin + "/api/product/model-settings",
      channelBranding: {},
      networkEnvironment: "local",
    };
  }
  const identityDir = path.join(dataDir, "local-memory");
  async function memoryFile(filename) {
    try {
      const content = await fs.readFile(path.join(identityDir, filename), "utf8");
      return { content, exists: true, malformed: false };
    } catch (error) {
      if (error.code === "ENOENT") return { content: "", exists: false, malformed: false };
      throw error;
    }
  }
  async function saveIdentity(kind, value) {
    const filenames = { user: "USER.md", ai: "IDENTITY.md", soul: "SOUL.md", memory: "MEMORY.md" },
      filename = filenames[kind];
    const text = String(value ?? "").trim();
    if (text.length > 1000000) throw Error("Identity file exceeds 1 MB");
    await fs.mkdir(identityDir, { recursive: true });
    await fs.writeFile(
      path.join(identityDir, filename),
      kind === "user" || kind === "ai" ? "Name: " + text + "\n" : text,
      { mode: 0o600 },
    );
    settings.localIdentity = { ...settings.localIdentity, [kind]: text };
    await persist();
    await rest("/memories/local-identity-" + kind, "PUT", {
      name: filename,
      content:
        kind === "user" ? "用户希望被称为：" + text : kind === "ai" ? "助手的名字：" + text : text,
    });
    if (kind === "ai") emit("identity:changed", { name: text });
    return { success: true, name: text };
  }
  async function syncPersonalization(value = {}) {
    const tones = {
      professional: "专业严谨",
      friendly: "友好亲切",
      straightforward: "直接坦诚",
      creative: "富有创意",
      efficient: "简洁高效",
      sarcastic: "诙谐讽刺",
      socratic: "启发引导，用提问引导思考、授人以渔",
    };
    const lines = [];
    if (value.toneStyle)
      lines.push("用户偏好的回答风格：" + (tones[value.toneStyle] || value.toneStyle) + "。");
    if (value.customPrompt?.trim()) lines.push(value.customPrompt.trim());
    return rest("/memories/desktop-personalization", "PUT", {
      name: "桌面个性化偏好",
      content: lines.join("\n"),
    });
  }
  function savePersonalization(value) {
    const operation = personalizationWrites.then(async () => {
      const existed = Object.hasOwn(settings.values, "personalization");
      const previous = settings.values.personalization;
      settings.values.personalization = value;
      try {
        await persist();
        await syncPersonalization(value);
      } catch (error) {
        if (existed) settings.values.personalization = previous;
        else delete settings.values.personalization;
        try {
          await persist();
          await syncPersonalization(previous || {});
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Personalization save and rollback failed");
        }
        throw error;
      }
      emit("config:changed", { key: "personalization", value });
      return value;
    });
    personalizationWrites = operation.catch(() => {});
    return operation;
  }
  async function findSkill(arg) {
    const id = String(
      typeof arg === "string" ? arg : arg?.id || arg?.filePath || arg?.path || arg?.name || "",
    ).replace(/^local-skill:/, "");
    const skills = await rest("/skills");
    return resolveSkill(skills, id);
  }
  async function reloadLocalSkill(skill) {
    if (!skill.localRootDir) return skill;
    const root = await fs.realpath(skill.localRootDir);
    const installedRoot = await fs.realpath(path.join(dataDir, "skills"));
    if (!root.startsWith(installedRoot + path.sep)) throw Error("Skill package escapes installed skills root");
    const filename = await fs.realpath(path.join(root, "SKILL.md"));
    if (!filename.startsWith(root + path.sep)) throw Error("Skill instructions escape package");
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 1000000) throw Error("Skill instructions must be a file under 1 MB");
    const content = await fs.readFile(filename, "utf8");
    if (content === skill.content) return skill;
    return rest("/skills/" + encodeURIComponent(skill.id), "PUT", { content, ...skillInvocationChanges(skill.content, content) });
  }
  async function resolveDefaultWorkspaceRoot(input, create = false) {
    if (typeof input !== "string") throw Error("Default workspace path must be absolute");
    const expanded = input === "~" ? homeDir : input.startsWith("~/") ? path.join(homeDir, input.slice(2)) : input;
    if (!path.isAbsolute(expanded)) throw Error("Default workspace path must be absolute");
    const root = await canonicalWritePath(expanded);
    const privateRoot = await fs.realpath(dataDir);
    const installationRoot = await fs.realpath(path.resolve(__dirname, ".."));
    if (root === privateRoot || root.startsWith(privateRoot + path.sep) || root === installationRoot || root.startsWith(installationRoot + path.sep))
      throw Error("Application data and installation directories cannot be default workspaces");
    if (create) await fs.mkdir(root, { recursive: true });
    if (!(await fs.stat(root)).isDirectory()) throw Error("Default workspace path must be a directory");
    return fs.realpath(root);
  }
  async function findExpert(arg) {
    const id = typeof arg === "string" ? arg : arg?.expertId || arg?.id;
    if (String(id).startsWith("custom-expert:")) {
      const scanned = await syncCustomExperts();
      if (!scanned.experts.some((expert) => expert.id === id))
        throw Error("Local expert package unavailable");
    }
    const expert = await rest("/experts/" + encodeURIComponent(id)) || (publicExpertCatalog
      ? (await require("./expert-catalog.cjs").catalog(origin)).experts.find(item => item.id === id) : null);
    if (!expert) throw new Error("Expert not found");
    return expert;
  }
  async function syncCustomExperts() {
    const scanned = await require("./custom-experts.cjs").scanCustomExperts(
      path.join(path.dirname(dataDir), "expert-config"),
    );
    for (const expert of scanned.experts)
      await rest("/experts/" + encodeURIComponent(expert.id), "PUT", expert);
    return scanned;
  }
  async function listAvailableExperts() {
    const scanned = await syncCustomExperts();
    const validIds = new Set(scanned.experts.map(expert => expert.id));
    const local = (await rest("/experts")).filter(expert => expert.source !== "local-expert-package" || validIds.has(expert.id));
    const ids = new Set(local.map(item => item.id));
    const publicExperts = publicExpertCatalog ? (await require("./expert-catalog.cjs").catalog(origin)).experts.filter(item => !ids.has(item.id)) : [];
    return {
      experts: [...local, ...publicExperts].map(expertSummary),
      errors: scanned.errors,
    };
  }
  const activePrompts = new Set();
  const selectedAttachments = new Set();
  async function canonicalWritePath(input) {
    let current = path.resolve(input);
    const missing = [];
    while (true) {
      try {
        return path.join(await fs.realpath(current), ...missing);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const entry = await fs.lstat(current).catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        });
        if (entry?.isSymbolicLink()) throw Error("Unresolved symbolic link in file path");
        missing.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }
  async function resolvePreviewPath(arg, options = {}) {
    const uploaded = typeof arg === "string" && arg.startsWith("workbuddy-attachment:");
    const filename = uploaded
      ? await resolveUploadedAttachment(arg)
      : await fs.realpath(
          typeof arg === "string" && arg.startsWith("file:") ? fileURLToPath(arg) : arg,
        );
    return authorizePreviewPath(filename, options, uploaded);
  }
  async function authorizePreviewPath(filename, options = {}, uploaded = false) {
    const privateRoot = await fs.realpath(dataDir);
    if (!uploaded && (filename === privateRoot || filename.startsWith(privateRoot + path.sep)))
      throw Error("Application private files cannot be previewed");
    const session = options.sessionId
      ? await rest("/sessions/" + encodeURIComponent(options.sessionId))
      : null;
    const workspace = session?.workspace || (await rest("/config")).workspace;
    const root = workspace ? await fs.realpath(workspace) : null;
    if (options.allowedDirs !== undefined && !Array.isArray(options.allowedDirs))
      throw Error("File preview allowedDirs must be an array");
    let extraAllowed = false;
    for (const directory of options.allowedDirs || []) {
      if (typeof directory !== "string" || !directory.trim()) continue;
      const candidate = directory.startsWith("file:") ? fileURLToPath(directory) : directory;
      if (!path.isAbsolute(candidate)) continue;
      const allowed = await canonicalWritePath(candidate);
      if (
        filename === allowed ||
        filename.startsWith(allowed.endsWith(path.sep) ? allowed : allowed + path.sep)
      )
        extraAllowed = true;
    }
    const homeRoot = homeDir ? await fs.realpath(homeDir) : null;
    const inHome =
      homeRoot &&
      (filename === homeRoot ||
        filename.startsWith(homeRoot.endsWith(path.sep) ? homeRoot : homeRoot + path.sep));
    if (
      !uploaded &&
      !inHome &&
      !extraAllowed &&
      !selectedAttachments.has(filename) &&
      (!root || (filename !== root && !filename.startsWith(root + path.sep)))
    )
      throw Error("File preview is outside the selected workspace");
    return filename;
  }
  async function resolveUploadedAttachment(uri) {
    const url = new URL(uri);
    if (url.protocol !== "workbuddy-attachment:" || !/^[a-f0-9-]{36}$/.test(url.hostname))
      throw Error("Invalid attachment reference");
    const privateRoot = await fs.realpath(dataDir);
    const root = await fs.realpath(path.join(dataDir, "attachments"));
    if (!root.startsWith(privateRoot + path.sep))
      throw Error("Attachment storage escapes data root");
    const filename = await fs.realpath(path.join(root, url.hostname));
    if (!filename.startsWith(root + path.sep)) throw Error("Attachment escapes storage root");
    return filename;
  }

  const cancelledSessions = new Set();
  const permissionTools = new Map();
  function sessionEvent(sessionId, event) {
    emit("session:event:" + sessionId, { ...event, sessionId });
  }
  function textUpdate(sessionId, role, text, messageId, replay = false, timestamp) {
    const timeMeta = Number.isFinite(timestamp) ? { timestamp } : {};
    sessionEvent(sessionId, {
      update: {
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text },
        _meta: { "codebuddy.ai/messageId": messageId, ...timeMeta },
      },
      _meta: {
        ...(replay ? { "codebuddy.ai/historyReplay": replay === true ? "chunk" : replay } : {}),
        ...timeMeta,
      },
    });
  }
  async function setSessionStatus(sessionId, status, pendingInputKind = null) {
    const updatedAt = new Date().toISOString();
    const session = await upsertSession(sessionId, {
      status,
      pendingInputKind,
      updatedAt,
      lastActivityAt: updatedAt,
    });
    sessionEvent(sessionId, {
      type: "sessionStatusUpdate",
      status,
      pendingInputKind,
      updatedAt,
      lastActivityAt: updatedAt,
    });
    return session;
  }
  function rendererToolName(name) {
    return (
      {
        skill_invoke: "Skill",
        workspace_write: "Write",
        shell_execute: "Bash",
        workspace_read: "Read",
        expert_resource_read: "Read",
        skill_resource_read: "Read",
        workspace_list: "Glob",
        workspace_search: "Grep",
      }[name] || name
    );
  }
  function rendererToolInput(name, args = {}) {
    args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (name === "skill_invoke") return { ...args, command: args.skill || args.skillId };
    return [
      "workspace_write",
      "workspace_read",
      "expert_resource_read",
      "skill_resource_read",
    ].includes(name)
      ? { ...args, file_path: args.path }
      : args;
  }
  function rendererToolStatus(result) {
    return result?.error ||
      (typeof result === "string" &&
        /^(?:permission denied|denied|permission rejected|rejected)(?:\b|:)/i.test(result.trim()))
      ? "failed"
      : "completed";
  }
  function rendererToolMetadata(name, args, approval = false) {
    const meta = {
      "codebuddy.ai/toolName": rendererToolName(name),
      "codebuddy.ai/localToolName": name,
    };
    if (approval && name !== "shell_execute")
      Object.assign(meta, {
        "codebuddy.ai/sandboxIntercept": true,
        "codebuddy.ai/interceptType": "application-permission",
        "codebuddy.ai/operation": name === "workspace_write" ? "write_file" : "invoke_tool",
        "codebuddy.ai/target": name === "workspace_write" ? args.path : name,
        "codebuddy.ai/description":
          (name === "workspace_write"
            ? "请求写入文件：" + args.path
            : "本地工具 " + name + " 请求执行权限。") +
          "这是应用权限确认，不提供操作系统沙箱隔离。",
      });
    return meta;
  }
  function pendingPermissionEvent(sessionId, pending) {
    const toolCallId = permissionTools.get(pending.id) || pending.id;
    permissionTools.set(pending.id, toolCallId);
    const toolCall = {
      sessionUpdate: "tool_call",
      toolCallId,
      title: pending.name,
      kind: pending.name === "shell_execute" ? "execute" : "edit",
      status: "pending",
      rawInput: {
        ...rendererToolInput(pending.name, pending.args),
        ...(!["workspace_write", "shell_execute"].includes(pending.name)
          ? { command: pending.name + " " + JSON.stringify(pending.args) }
          : {}),
      },
      _meta: rendererToolMetadata(pending.name, pending.args, true),
    };
    sessionEvent(sessionId, { update: toolCall });
    const request = {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow_once", name: "允许本次", kind: "allow_once" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    };
    sessionEvent(sessionId, {
      type: "permissionRequest",
      requestId: pending.id,
      toolCallId: pending.id,
      request,
    });
    return { requestId: pending.id, toolCallId: pending.id, request };
  }
  async function pendingFor(sessionId) {
    return (await rest("/approvals")).filter((item) => item.sessionId === sessionId);
  }
  async function replayTextHistory(sessionId) {
    if (activePrompts.has(sessionId)) return { replayed: 0, complete: false };
    const messages = (
      await rest("/sessions/" + encodeURIComponent(sessionId) + "/messages")
    ).filter((message) => ["user", "assistant"].includes(message.role));
    const events = await rest("/sessions/" + encodeURIComponent(sessionId) + "/events");
    const waiting = new Map(),
      completedTools = [];
    const turns = messages
      .filter((message) => message.role === "user")
      .map((message) => ({ id: message.id, time: Date.parse(message.createdAt) }))
      .filter((turn) => Number.isFinite(turn.time))
      .sort((a, b) => a.time - b.time);
    for (const event of [...events].reverse()) {
      const turn = turns.findLast((turn) => turn.time <= Date.parse(event.createdAt));
      const key = event.data.toolCallId
        ? "id:" + event.data.toolCallId
        : JSON.stringify(["legacy", turn?.id || "unknown", event.data.name]);
      if (event.event === "tool") {
        if (!waiting.has(key)) waiting.set(key, []);
        waiting.get(key).push(event);
      } else if (event.event === "tool_result") {
        const start = waiting.get(key)?.shift();
        if (start)
          completedTools.push({ start, result: event.data.result, finishedAt: event.createdAt });
      }
    }
    const timeline = [
      ...messages.map((message) => ({
        date: message.createdAt,
        priority: message.role === "user" ? 0 : 2,
        message,
      })),
      ...completedTools.map((tool) => ({ date: tool.start.createdAt, priority: 1, tool })),
    ].sort(
      (a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.priority - b.priority,
    );
    const historyBoundary = (boundary) =>
      sessionEvent(sessionId, {
        update: { sessionUpdate: "session_info_update" },
        _meta: { "codebuddy.ai/historyReplay": boundary },
      });
    historyBoundary("start");
    for (const entry of timeline) {
      if (entry.message) {
        const message = entry.message;
        textUpdate(
          sessionId,
          message.role,
          message.content,
          message.id,
          "chunk",
          Date.parse(message.createdAt),
        );
        for (const content of message.media || []) {
          sessionEvent(sessionId, {
            update: { sessionUpdate: "user_message_chunk", content, _meta: { "codebuddy.ai/messageId": message.id } },
            _meta: { "codebuddy.ai/historyReplay": "chunk", timestamp: Date.parse(message.createdAt) },
          });
        }
      } else {
        const { start, result, finishedAt } = entry.tool,
          name = start.data.name;
        const toolCallId = sessionId + ":history-tool:" + start.id;
        const nextUserTime = Math.min(
          ...messages
            .filter(
              (message) =>
                message.role === "user" &&
                Date.parse(message.createdAt) > Date.parse(start.createdAt),
            )
            .map((message) => Date.parse(message.createdAt)),
        );
        const assistant = messages.find(
          (message) =>
            message.role === "assistant" &&
            Date.parse(message.createdAt) >= Date.parse(start.createdAt) &&
            Date.parse(message.createdAt) < nextUserTime,
        );
        const messageId = assistant?.id || sessionId + ":history-tool-message:" + start.id;
        const historyMeta = {
          "codebuddy.ai/historyReplay": "chunk",
          "codebuddy.ai/messageId": messageId,
        };
        sessionEvent(sessionId, {
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: name,
            kind:
              name === "shell_execute" ? "execute" : name === "workspace_write" ? "edit" : "other",
            status: rendererToolStatus(result),
            rawInput: rendererToolInput(name, start.data.args),
            _meta: {
              ...rendererToolMetadata(name, start.data.args),
              "codebuddy.ai/messageId": messageId,
            },
          },
          _meta: { ...historyMeta, timestamp: Date.parse(start.createdAt) },
        });
        sessionEvent(sessionId, {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: rendererToolStatus(result),
            rawInput: rendererToolInput(name, start.data.args),
            rawOutput: result,
            _meta: {
              ...rendererToolMetadata(name, start.data.args),
              "codebuddy.ai/messageId": messageId,
            },
            content: [{ type: "content", content: { type: "text", text: JSON.stringify(result) } }],
          },
          _meta: { ...historyMeta, timestamp: Date.parse(finishedAt) },
        });
      }
    }
    historyBoundary("end");
    return { replayed: messages.length, complete: true };
  }
  async function promptSession(sessionId, blocks, meta = {}) {
    if (activePrompts.has(sessionId)) throw Error("Session is already running");
    let promptBlocks = typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks || [];
    if (!Array.isArray(promptBlocks)) throw Error("Message content must be an array");
    if (promptBlocks.some((block) => !block || typeof block !== "object" || Array.isArray(block)))
      throw Error("Message blocks must be objects");
    promptBlocks = promptBlocks.map((block) => ({ ...block }));
    const media = promptBlocks.filter((block) => ["image", "audio"].includes(block.type)).map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    mediaParts(media);
    for (const block of promptBlocks) {
      if (
        block?.type === "resource" &&
        typeof block.resource?.text !== "string" &&
        !block.uri?.startsWith("file:") &&
        !block.resource?.uri?.startsWith("file:")
      )
        throw Error("嵌入附件尚无可读取的文本内容，不能忽略附件后继续回答。");
    }
    const references = [];
    for (const block of promptBlocks) {
      const blockMeta = block._meta || block.meta || {};
      if (
        block.type === "resource_link" &&
        (block.uri?.startsWith("skill://") ||
          blockMeta.mentionType === "skill" ||
          blockMeta.type === "skill" ||
          blockMeta.isSkill === true)
      ) {
        const raw = block.uri?.startsWith("skill://")
          ? block.uri.slice(8)
          : blockMeta.attachedSkill?.name ||
            blockMeta.commandName ||
            (block.uri?.startsWith("command://") ? block.uri.slice(10) : undefined) ||
            blockMeta.displayText ||
            block.name;
        if (!raw) throw Error("技能链接缺少名称");
        try {
          references.push(decodeURIComponent(raw));
        } catch {
          throw Error("技能链接格式无效");
        }
      }
      if (block.type === "text")
        for (const match of String(block.text || "").matchAll(
          /(?:^|\s)@skill:("(?:\\.|[^"\\])*"|[^\s]+)/g,
        )) {
          const raw = match[1];
          references.push(raw.startsWith('"') ? JSON.parse(raw) : raw);
        }
    }
    const session = await rest("/sessions/" + encodeURIComponent(sessionId));
    for (let index = 0; index < promptBlocks.length; index++) {
      const block = promptBlocks[index],
        uri = block.uri || block.resource?.uri;
      if (
        !["resource", "resource_link"].includes(block.type) ||
        !uri?.startsWith("workbuddy-attachment:")
      )
        continue;
      const filename = await resolveUploadedAttachment(uri);
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 100000) throw Error("Invalid text attachment");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(filename));
      if (text.includes("\0")) throw Error("Attachment is not text");
      promptBlocks[index] = { ...block, type: "resource", resource: { uri, text } };
    }
    for (let index = 0; index < promptBlocks.length; index++) {
      const block = promptBlocks[index],
        uri = block.uri || block.resource?.uri;
      const explicitlySelected =
        block._meta?.mentionType === "file" &&
        block._meta.filePath === uri &&
        typeof uri === "string" &&
        path.isAbsolute(uri);
      if (
        ["resource", "resource_link"].includes(block.type) &&
        typeof uri === "string" &&
        path.isAbsolute(uri) &&
        !explicitlySelected
      )
        throw Error("文件引用缺少明确的选择元数据，不能忽略后继续回答。");
      const fileUri = uri?.startsWith("file:")
        ? uri
        : explicitlySelected
          ? pathToFileURL(uri).href
          : null;
      if (
        !["resource", "resource_link"].includes(block.type) ||
        !fileUri ||
        typeof block.resource?.text === "string"
      )
        continue;
      if (!session.workspace) throw Error("选择工作空间后才能读取文件附件。");
      const root = await fs.realpath(session.workspace),
        filename = await fs.realpath(fileURLToPath(fileUri));
      const privateRoot = await fs.realpath(dataDir);
      if (
        (!explicitlySelected && !filename.startsWith(root + path.sep)) ||
        filename === privateRoot ||
        filename.startsWith(privateRoot + path.sep)
      )
        throw Error("文件附件不在当前工作空间内，或位于应用私有目录。");
      const stat = await fs.stat(filename);
      const audioMime = { ".wav": "audio/wav", ".mp3": "audio/mpeg" }[path.extname(filename).toLowerCase()];
      if (audioMime) {
        if (!stat.isFile() || stat.size > 5_000_000) throw Error("音频附件必须是小于5MB的文件。");
        media.push({ type: "audio", mimeType: audioMime, data: (await fs.readFile(filename)).toString("base64") });
        mediaParts(media);
        if (explicitlySelected) selectedAttachments.add(filename);
        promptBlocks[index] = { type: "text", text: "音频附件：" + path.basename(filename) };
        continue;
      }
      if (!stat.isFile() || stat.size > 100000) throw Error("文本附件必须是小于100000字节的文件。");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(filename));
      if (text.includes("\0")) throw Error("附件不是可读取的文本文件。");
      if (explicitlySelected) selectedAttachments.add(filename);
      promptBlocks[index] = { ...block, type: "resource", resource: { uri, text } };
    }
    if (String(session.expertId || "").startsWith("custom-expert:"))
      await findExpert(session.expertId);
    let selectedSkills = [];
    if (references.length || session.skillIds?.length) {
      await ensureSeed();
      const skills = await rest("/skills");
      selectedSkills = [...new Set([...(session.skillIds || []), ...references])].map((reference) =>
        resolveSkill(skills, reference),
      );
    }
    const selectedSkillIds = [...new Set(selectedSkills.map((skill) => skill.id))];
    const text = promptBlocks
      .filter((block) => ["text", "resource"].includes(block.type))
      .map((block) =>
        block.type === "text"
          ? block.text || ""
          : "引用附件（已读取全文，请直接依据以下内容回答，无需再调用工具读取文件）：" +
            (block.name || path.basename(block.resource.uri || "文本文件")) +
            "\n" +
            block.resource.text,
      )
      .join("\n");
    const content = [...references.map((reference) => "使用技能：" + reference), text]
      .filter(Boolean)
      .join("\n");
    if (!content.trim() && !media.length) throw Error("Message text required");
    activePrompts.add(sessionId);
    cancelledSessions.delete(sessionId);
    await setSessionStatus(sessionId, "running");
    // The renderer inserts the live user message before invoking this RPC.
    // Persist through the backend; replay user chunks only when loading history.
    const assistantId = randomUUID(),
      tools = new Map(),
      executions = new Map();
    const emitTool = (name, args, status = "in_progress", reuse = false) => {
      const id = (reuse && tools.get(name)) || randomUUID();
      tools.set(name, id);
      const tool = {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: name,
        kind: name === "shell_execute" ? "execute" : name === "workspace_write" ? "edit" : "other",
        status,
        rawInput: {
          ...rendererToolInput(name, args),
          ...(status === "pending" && !["workspace_write", "shell_execute"].includes(name)
            ? { command: name + " " + JSON.stringify(args) }
            : {}),
        },
        _meta: rendererToolMetadata(name, args, status === "pending"),
      };
      sessionEvent(sessionId, { update: tool });
      return tool;
    };
    try {
      if (
        settings.values.personalization &&
        (Object.hasOwn(settings.values.personalization, "customPrompt") ||
          settings.values.personalization.toneStyle)
      )
        await syncPersonalization(settings.values.personalization);
      const response = await fetchImpl(
        origin + "/api/sessions/" + encodeURIComponent(sessionId) + "/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: content || "请分析附件。",
            media,
            mode: session.mode || "craft",
            expertId: session.expertId,
            editingExpertId: selectedSkills.some((skill) => canonicalSkillName(skill) === "expert-manager")
              ? text.match(/custom-expert:[a-z0-9]+(?:-[a-z0-9]+)*/)?.[0]
              : undefined,
            skillIds: selectedSkillIds,
          }),
        },
      );
      if (!response.ok) throw Error((await response.json()).error || "Chat request failed");
      let buffer = "",
        decoder = new TextDecoder(),
        failure;
      const handle = async (packet) => {
        let event = "",
          raw = "";
        for (const line of packet.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) raw += line.slice(5).trim();
        }
        if (!raw) return;
        const data = JSON.parse(raw);
        if (event === "delta") textUpdate(sessionId, "assistant", data.text || "", assistantId);
        else if (event === "tool") {
          const card = emitTool(data.name, data.args);
          if (data.toolCallId) executions.set(data.toolCallId, { card, args: data.args });
        } else if (event === "tool_result") {
          await setSessionStatus(sessionId, "running");
          if (data.result?.created === true) {
            if (data.name === "skill_instructions_create")
              emit("skill:packagesChanged", { source: "created", skillId: data.result.skillId });
            if (data.name === "expert_package_create")
              emit("expert:packagesChanged", { source: "created", expertId: data.result.expertId });
          }
          const execution = executions.get(data.toolCallId);
          const id = execution?.card.toolCallId || tools.get(data.name) || randomUUID();
          sessionEvent(sessionId, {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: id,
              status: rendererToolStatus(data.result),
              ...(execution
                ? {
                    rawInput: rendererToolInput(data.name, execution.args),
                    _meta: rendererToolMetadata(data.name, execution.args),
                  }
                : {}),
              content: [
                { type: "content", content: { type: "text", text: JSON.stringify(data.result) } },
              ],
              rawOutput: data.result,
            },
          });
          if (data.name === "mcp_call" && execution?.args && Array.isArray(data.result?.content)) {
            try {
              const opened = await rest("/connectors/apps/notify-agent", "POST", {
                sessionId,
                toolCallId: id,
                serverId: execution.args.serverId,
                prefixedToolName: execution.args.name,
                rawInput: execution.args.arguments,
              });
              if (opened.handled) {
                await rest("/connectors/apps/push-result", "POST", {
                  appInstanceId: opened.appInstanceId,
                  sessionId,
                  toolCallId: id,
                  result: data.result,
                });
                emit("mcpApps:openHostRequested", {
                  ...opened.descriptor,
                  sessionId,
                  toolCallId: id,
                });
              }
            } catch (error) {
              emit("mcpApps:openHostError", { sessionId, toolCallId: id, error: error.message });
            }
          }
        } else if (event === "approval") {
          await setSessionStatus(sessionId, "pending", "permission");
          const tool = emitTool(data.name, data.args, "pending", true);
          permissionTools.set(data.id, tool.toolCallId);
          sessionEvent(sessionId, {
            type: "permissionRequest",
            requestId: data.id,
            toolCallId: tool.toolCallId,
            request: {
              sessionId,
              toolCall: tool,
              options: [
                { optionId: "allow_once", name: "允许本次", kind: "allow_once" },
                { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
              ],
            },
          });
        } else if (event === "error") {
          failure = new Error(data.message || "Model error");
          if (!cancelledSessions.has(sessionId))
            sessionEvent(sessionId, { type: "error", message: failure.message });
        }
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          await handle(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.trim()) await handle(buffer);
      if (cancelledSessions.has(sessionId)) {
        await setSessionStatus(sessionId, "cancelled");
        const result = { stopReason: "cancelled" };
        sessionEvent(sessionId, { type: "promptResponse", response: result });
        return result;
      }
      if (failure) throw failure;
      await setSessionStatus(sessionId, "completed");
      const result = { stopReason: "end_turn" };
      sessionEvent(sessionId, { type: "promptResponse", response: result });
      return result;
    } catch (error) {
      if (cancelledSessions.has(sessionId)) {
        await setSessionStatus(sessionId, "cancelled");
        const result = { stopReason: "cancelled" };
        sessionEvent(sessionId, { type: "promptResponse", response: result });
        return result;
      }
      if (error.name === "TimeoutError" || /aborted due to timeout/i.test(error.message)) {
        error = new Error("请求超时，请检查模型服务状态后重试；本次未收到任务完成结果。");
        error.code = "LOCAL_REQUEST_TIMEOUT";
      }
      await setSessionStatus(sessionId, "failed");
      sessionEvent(sessionId, {
        type: "promptResponse",
        response: { stopReason: "cancelled", _meta: { error: error.message } },
        origin: "synthetic",
      });
      throw error;
    } finally {
      activePrompts.delete(sessionId);
    }
  }
  async function updateSessionConfig(sessionId, patch = {}, options = {}) {
    if (!sessionId || !patch || typeof patch !== "object" || Array.isArray(patch))
      throw Error("Session id and config object required");
    const previous = await rest("/sessions/" + encodeURIComponent(sessionId));
    if (!previous) throw Error("Session not found");
    if (
      Object.hasOwn(options || {}, "expectedExpertId") &&
      (previous.expertId || null) !== (options.expectedExpertId || null)
    )
      return {
        ...sessionSummary(previous),
        modeEpoch: previous.modeEpoch || 0,
        configUpdateApplied: false,
      };
    const config = {
      ...previous.config,
      ...patch,
      permissionMode: "default",
      useSandboxCLI: false,
    };
    const data = { config, modeEpoch: (previous.modeEpoch || 0) + 1 };
    for (const field of [
      "systemPrompt",
      "expertId",
      "skillIds",
      "locale",
      "welcomeMode",
      "addonSelection",
      "sessionSettings",
    ])
      if (Object.hasOwn(patch, field)) data[field] = patch[field];
    if (Object.hasOwn(patch, "mode"))
      data.mode = patch.mode === "ask" || patch.mode === "plan" ? "ask" : "craft";
    if (Object.hasOwn(patch, "model"))
      data.model = String(patch.model).replace(/^custom-local:/, "");
    const updated = await upsertSession(sessionId, data);
    return { ...sessionSummary(updated), modeEpoch: updated.modeEpoch, configUpdateApplied: true };
  }
  async function upsertSession(id, data) {
    const session = await rest("/sessions/" + encodeURIComponent(id), "PUT", data);
    emit("session:upserted", sessionSummary(session));
    return session;
  }
  const aliases = {
    "wb:account:get": "auth:getAccount",
    "wb:account:getAccount": "auth:getAccount",
    "wb:account:getUserInfo": "auth:getUserInfo",
    "wb:account:updateNickname": "auth:updateAccountNickname",
    "wb:config:get": "config:get",
    "wb:config:set": "config:set",
    "wb:config:getAll": "config:getAll",
    "wb:config:preference": "config:get",
    "wb:config:setPreference": "config:set",
    "wb:config:getProductConfiguration": "config:getProductConfiguration",
    "wb:config:getProductScenes": "config:getProductScenes",
    "wb:models:list": "models:list",
    "wb:models:getLocalCustomModels": "config:getLocalCustomModels",
    "wb:models:saveLocalCustomModel": "config:saveLocalCustomModel",
    "wb:models:deleteLocalCustomModel": "config:deleteLocalCustomModel",
    "wb:models:testLocalCustomModel": "config:testLocalCustomModel",
    "wb:skills:list": "skill:list",
    "wb:skills:content": "skill:getContent",
    "wb:skills:getContent": "skill:getContent",
    "wb:skills:toggle": "skill:toggle",
    "wb:skills:delete": "skill:delete",
    "wb:skills:import": "skill:import",
    "wb:experts:getExperts": "expert:getExperts",
    "wb:experts:getExpert": "expert:getExpert",
    "wb:experts:getCategories": "expert:getCategories",
    "wb:experts.recents:add": "expert-history:add",
    "wb:experts.recents:remove": "expert-history:remove",
    "wb:experts.recents:clear": "expert-history:clear",
    "wb:workspaces:list": "storage:getWorkspaces",
    "wb:workspaces:open": "workspace:open",
  };
  async function prepareDownload(arg, { allowHttp = false } = {}) {
    const skillName = typeof arg?.skillName === "string" ? arg.skillName.trim() : "",
      urlText = typeof arg?.downloadUrl === "string" ? arg.downloadUrl.trim() : "";
    if (!skillName)
      return {
        success: false,
        errorKey: "invalidSkillId",
        errorMessage: "Missing required skill identifier",
      };
    let url;
    try {
      url = new URL(urlText);
      if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw Error();
    } catch {
      return {
        success: false,
        errorKey: "invalidDownloadUrl",
        errorMessage: "Skill package URL must use https://",
      };
    }
    const directory = await fs.mkdtemp(
      path.join(require("node:os").tmpdir(), "wb-local-skill-download-"),
    );
    const markdown = path.extname(url.pathname).toLowerCase() === ".md",
      filename = path.join(directory, markdown ? "SKILL.md" : "package.zip");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 60000);
    let handle, httpStatus;
    try {
      const response = await fetchImpl(url.href, {
        signal: controller.signal,
        headers: {
          Accept: "application/zip, application/octet-stream, text/markdown, text/plain, */*",
          "Cache-Control": "no-cache",
        },
      });
      httpStatus = response.status;
      if (
        response.url &&
        new URL(response.url).protocol !== "https:" &&
        !(allowHttp && new URL(response.url).protocol === "http:")
      )
        throw Error("invalidDownloadUrl");
      if (!response.ok || !response.body) throw Error("installFromUrlFailed");
      const limit = 50 * 1024 * 1024;
      if (Number(response.headers?.get("content-length")) > limit) throw Error("downloadTooLarge");
      handle = await fs.open(filename, "wx", 0o600);
      let total = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > limit) throw Error("downloadTooLarge");
        await handle.writeFile(bytes);
      }
      await handle.close();
      handle = null;
      return { success: true, downloadedFilePath: markdown ? directory : filename, skillName };
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
      return {
        success: false,
        errorKey: ["downloadTooLarge", "invalidDownloadUrl"].includes(error.message)
          ? error.message
          : "installFromUrlFailed",
        errorMessage:
          error.message === "downloadTooLarge"
            ? "Skill package exceeds size limit (52428800 bytes)"
            : error.message === "invalidDownloadUrl"
              ? "Redirected skill package URL must also use https://"
              : httpStatus
                ? `Failed to download skill package (HTTP ${httpStatus})`
                : "Failed to download skill package",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async function dispatch(inputChannel, args = [], context) {
    await loadSettings();
    if (
      inputChannel !== "skill:prepareFromUrl" &&
      /^(expert:|skill:|builtin-market:|wb:(experts|skills)[:.])/.test(inputChannel)
    )
      await ensureSeed();
    const channel = aliases[inputChannel] || inputChannel;
    const arg = args[0];
    switch (channel) {
      case "daemon:ping":
        return { ok: true };
      case "appearance:listResources":
        // Base light/dark themes are supplied by the original renderer.
        return [];
      case "appearance:setSelection": {
        const resourceKey = typeof arg === "string" ? args[1] : arg?.resourceKey;
        if (!["light", "dark"].includes(resourceKey)) throw Error("Local theme resource is unavailable");
        await dispatch("config:set", ["appearanceSelection", { type: "theme", resourceKey }]);
        return { saved: true, source: "local" };
      }
      case "wb:config:setTheme": {
        if (!["light", "dark", "system"].includes(arg)) throw Error("Unsupported theme mode");
        await dispatch("config:set", ["theme", arg]);
        return { saved: true, source: "local" };
      }
      case "__bootstrap":
        return {};
      case "auth:getAccount":
        return { ...settings.account, type: "personal", enterpriseId: "" };
      case "auth:getUserInfo":
        return { ...settings.account, username: settings.account.nickname, source: "local" };
      case "auth:getToken":
        return null;
      case "auth:getAccountUsage":
        return { source: "local", billingProvider: "user-configured", available: false };
      case "auth:login":
        settings.account ||= { uid: "local:" + randomUUID(), nickname: "本地用户", isLocal: true };
        await persist();
        emit("auth:statusChanged", { loggedIn: true, account: settings.account });
        return settings.account;
      case "auth:logout":
        return unsupported(channel);
      case "auth:updateAccountNickname": {
        const value = typeof arg === "string" ? arg : arg?.nickname;
        if (typeof value !== "string") throw Error("Nickname must be text");
        const nickname = value.trim();
        if (!nickname || nickname.length > 20 || /[\u0000-\u001f\u007f]/.test(nickname))
          throw Error("Nickname must contain 1 to 20 characters without control characters");
        const previous = settings.account.nickname;
        settings.account.nickname = nickname;
        try { await persist(); } catch (error) { settings.account.nickname = previous; throw error; }
        emit("auth:statusChanged", { loggedIn: true, account: settings.account });
        return { success: true, nickname };
      }
      case "auth:savePendingInput":
        settings.pendingInput = arg;
        await persist();
        return { success: true };
      case "auth:loadPendingInput":
        return settings.pendingInput || null;
      case "auth:getActivityBanner":
        return null;
      case "config:get": {
        const key = typeof arg === "string" ? arg : arg?.key;
        if (key === "personalization") await personalizationWrites;
        const value = settings.values[key];
        if (
          key === "personalization" &&
          value &&
          (Object.hasOwn(value, "customPrompt") || value.toneStyle)
        )
          await syncPersonalization(value);
        return value ?? null;
      }
      case "config:getAll":
        await personalizationWrites;
        return settings.values;
      case "window:saveLocale": {
        const locale = arg?.locale;
        if (!["zh-CN", "en-US"].includes(locale)) throw Error("Unsupported display locale");
        await dispatch("config:set", ["locale", locale]);
        return { saved: true, locale };
      }
      case "window:saveDefaultWorkspacePath": {
        const root = await resolveDefaultWorkspaceRoot(arg?.path);
        await dispatch("config:set", ["defaultWorkspacePath", root]);
        return { saved: true, path: root };
      }
      case "config:set": {
        const key = typeof arg === "string" ? arg : arg?.key,
          value = typeof arg === "string" ? args[1] : arg?.value;
        if (!key) throw Error("Config key required");
        if (key === "personalization") {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw Error("Personalization must be an object");
          if (value.toneStyle !== undefined && !["", "professional", "friendly", "straightforward", "creative", "efficient", "sarcastic", "socratic"].includes(value.toneStyle))
            throw Error("Unsupported personalization tone");
          if (value.customPrompt !== undefined && (typeof value.customPrompt !== "string" || value.customPrompt.length > 1500))
            throw Error("Personalization instructions must be a string of at most 1500 characters");
          return savePersonalization(value);
        }
        const existed = Object.hasOwn(settings.values, key);
        const previous = settings.values[key];
        settings.values[key] = value;
        try {
          await persist();
        } catch (error) {
          if (existed) settings.values[key] = previous;
          else delete settings.values[key];
          throw error;
        }
        emit("config:changed", { key, value });
        return value;
      }
      case "config:getProductConfiguration":
        return productConfiguration();
      case "config:getProductScenes":
      {
        const english = typeof arg === "string" && !arg.startsWith("zh");
        const resources = path.join(__dirname, "../desktop-resources");
        const marketplace = JSON.parse(await fs.readFile(path.join(resources, "product-scenes", english ? "scenes-en.json" : "scenes.json"), "utf8"));
        const design = JSON.parse(await fs.readFile(path.join(resources,
          "vendor/plugins/workbuddy-builtin/skills/ardot-design-core", english ? "scenes-en.json" : "scenes.json"), "utf8"));
        return { scenes: [...design.filter((scene) => scene.mode === "design").map((scene) => ({ ...scene, plugins: [] })),
          ...marketplace.filter((scene) => scene.mode !== "design")] };
      }
      case "config:getClientMenus":
        return [];
      case "config:getLocalCustomModels":
        return modelsResult();
      case "config:testLocalCustomModel":
        return testModelConnectivity(arg, { fetchImpl });
      case "config:saveLocalCustomModel": {
        const model = arg?.model;
        if (!model?.id || !model.url) throw Error("Model id and endpoint required");
        const url = new URL(model.url);
        if (!["http:", "https:"].includes(url.protocol)) throw Error("Invalid endpoint");
        const previous = settings.models.find((m) => m.id === (arg.previousId || model.id));
        const next = {
          ...previous,
          ...model,
          ...(!model.apiKey && previous?.apiKey ? { apiKey: previous.apiKey } : {}),
        };
        const nextModels = settings.models.filter(
          (m) => m.id !== arg.previousId && m.id !== model.id,
        );
        nextModels.push(next);
        await saveModels(nextModels, () =>
          rest("/config", "PUT", {
            model: model.id,
            baseURL: model.url.replace(/\/chat\/completions\/?$/, ""),
            supportsTools: model.supportsToolCall !== false,
            apiKey: next.apiKey || "",
          }),
        );
        emit("config:productConfigurationChanged", {
          productConfiguration: await productConfiguration(),
        });
        return modelsResult();
      }
      case "config:deleteLocalCustomModel": {
        const id = typeof arg === "string" ? arg : arg?.id;
        const nextModels = settings.models.filter((m) => m.id !== id);
        const config = await rest("/config");
        await saveModels(nextModels, async () => {
          if (config.model === id) {
            const next = nextModels[0];
            await rest("/config", "PUT", {
              model: next?.id || "",
              apiKey: next?.apiKey || "",
              ...(next
                ? {
                    baseURL: next.url.replace(/\/chat\/completions\/?$/, ""),
                    supportsTools: next.supportsToolCall !== false,
                  }
                : {}),
            });
          }
        });
        emit("config:productConfigurationChanged", {
          productConfiguration: await productConfiguration(),
        });
        return modelsResult();
      }
      case "llm:enhancePrompt":
        return rest("/prompt/enhance", "POST", arg);
      case "models:list":
        return (await productConfiguration()).models;
      case "skill:installFromUrl": {
        const skillName = typeof arg?.skillName === "string" ? arg.skillName.trim() : "";
        const downloadUrl = typeof arg?.downloadUrl === "string" ? arg.downloadUrl.trim() : "";
        if (!skillName)
          return {
            success: false,
            errorKey: "invalidSkillId",
            errorMessage: "Missing required skill identifier",
          };
        if (!downloadUrl)
          return {
            success: false,
            errorKey: "invalidDownloadUrl",
            errorMessage: "Missing skill package path or URL",
          };
        try {
          let folderPath = downloadUrl;
          if (/^https:\/\//i.test(downloadUrl)) {
            const prepared = await dispatch(
              "skill:prepareFromUrl",
              [{ skillName, downloadUrl }],
              context,
            );
            if (!prepared.success) return prepared;
            folderPath = prepared.downloadedFilePath;
          }
          const result = await dispatch(
            "skill:import",
            [{ folderPath, overwrite: arg.overwrite, securityCheck: arg.securityCheck ?? true }],
            context,
          );
          if (!result.success)
            return { ...result, errorMessage: result.errorMessage || result.error };
          const id = result.skill.id;
          return {
            success: true,
            importedSkillIds: [id],
            activatedSkillId: id,
            skillName: result.skillName,
            installedFilePath: result.skill.filePath,
          };
        } catch (error) {
          return {
            success: false,
            errorKey:
              error.code === "LOCAL_SKILL_SCAN_UNAVAILABLE"
                ? "security_check_blocked"
                : "installFromUrlFailed",
            errorMessage: error.message,
          };
        }
      }
      case "skill:prepareFromUrl":
        return prepareDownload(arg);
      case "io:appendRecord": {
        if (!arg || typeof arg.filePath !== "string" || typeof arg.jsonLine !== "string")
          throw Error("Record append requires filePath and jsonLine strings");
        if (!path.isAbsolute(arg.filePath)) throw Error("Record append requires an absolute path");
        const root = await canonicalWritePath(path.join(dataDir, "logs"));
        const filename = await canonicalWritePath(arg.filePath);
        const relative = path.relative(root, filename);
        if (
          !relative ||
          relative.startsWith(".." + path.sep) ||
          relative === ".." ||
          path.isAbsolute(relative)
        )
          throw Error("Record append must stay inside application logs");
        const privateRoot = await fs.realpath(dataDir);
        if (root !== path.join(privateRoot, "logs"))
          throw Error("Application logs cannot be redirected");
        await fs.mkdir(path.dirname(filename), { recursive: true });
        if ((await canonicalWritePath(arg.filePath)) !== filename)
          throw Error("Record append path changed");
        await fs.appendFile(filename, arg.jsonLine, { encoding: "utf8", mode: 0o600 });
        return undefined;
      }
      case "file:upload": {
        if (!Array.isArray(arg?.files) || !arg.files.length || arg.files.length > 10)
          throw Error("Upload requires one to ten text files");
        const files = arg.files.map((file) => {
          if (!(file.data instanceof Uint8Array) || file.data.byteLength > 100000)
            throw Error("Text attachment exceeds 100000 bytes");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
          if (text.includes("\0")) throw Error("Binary attachments are not supported");
          return { bytes: file.data, name: path.basename(String(file.name || "attachment.txt")) };
        });
        const directory = path.join(dataDir, "attachments");
        await fs.mkdir(directory, { recursive: true });
        if (!(await fs.realpath(directory)).startsWith((await fs.realpath(dataDir)) + path.sep))
          throw Error("Attachment storage escapes data root");
        const urls = [];
        for (const file of files) {
          const id = randomUUID();
          await fs.writeFile(path.join(directory, id), file.bytes, { flag: "wx", mode: 0o600 });
          urls.push("workbuddy-attachment://" + id + "/" + encodeURIComponent(file.name));
        }
        return { success: true, urls };
      }
      case "file:search": {
        if (!arg || typeof arg.cwd !== "string") throw Error("File search requires cwd");
        const limit = arg.resultNum === undefined ? Infinity : arg.resultNum;
        if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0))
          throw Error("Invalid search result limit");
        const query = String(arg.search || "").toLowerCase(),
          results = [];
        let root;
        try {
          await resolvePreviewPath(arg.cwd, { allowedDirs: [arg.cwd] });
          root = path.resolve(arg.cwd.startsWith("file:") ? fileURLToPath(arg.cwd) : arg.cwd);
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
          throw error;
        }
        async function walk(directory) {
          if (results.length >= limit) return;
          let entries;
          try {
            entries = await fs.readdir(directory, { withFileTypes: true });
          } catch (error) {
            if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return;
            throw error;
          }
          for (const entry of entries) {
            if (results.length >= limit) break;
            if (
              entry.name.startsWith(".") ||
              ["node_modules", "__pycache__"].includes(entry.name) ||
              entry.isSymbolicLink()
            )
              continue;
            const fullPath = path.join(directory, entry.name);
            try {
              await resolvePreviewPath(fullPath, { allowedDirs: [root] });
            } catch (error) {
              if (
                ["ENOENT", "ENOTDIR"].includes(error.code) ||
                /private files|outside the selected workspace/.test(error.message)
              )
                continue;
              throw error;
            }
            if (!query || entry.name.toLowerCase().includes(query))
              results.push({
                path: fullPath,
                relativePath: path.relative(root, fullPath),
                fileName: entry.isFile() ? entry.name : undefined,
                folderName: entry.isDirectory() ? entry.name : undefined,
                type: entry.isDirectory() ? "folder" : "file",
              });
            if (entry.isDirectory() && results.length < limit) await walk(fullPath);
          }
        }
        await walk(root);
        return results;
      }
      case "file:listDir": {
        let directory;
        try {
          directory = await resolvePreviewPath(arg, { allowedDirs: [arg], ...(args[1] || {}) });
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
          throw error;
        }
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const rows = await Promise.all(
          entries.map(async (entry) => {
            try {
              const filename = await resolvePreviewPath(path.join(directory, entry.name), {
                allowedDirs: [directory],
              });
              const stat = await fs.stat(filename);
              return {
                name: entry.name,
                type: entry.isDirectory() ? "directory" : "file",
                size: stat.size,
              };
            } catch (error) {
              if (
                ["ENOENT", "ENOTDIR"].includes(error.code) ||
                /private files|outside the selected workspace/.test(error.message)
              )
                return null;
              throw error;
            }
          }),
        );
        return rows.filter(Boolean);
      }
      case "file:rename": {
        if (typeof arg !== "string" || typeof args[1] !== "string")
          throw Error("File rename requires source and destination paths");
        const options = args[2] || {};
        async function renameEntryPath(value) {
          const input = value.startsWith("file:") ? fileURLToPath(value) : value;
          if (!path.isAbsolute(input)) throw Error("File rename requires absolute paths");
          const entry = path.join(await fs.realpath(path.dirname(input)), path.basename(input));
          return authorizePreviewPath(entry, options);
        }
        const source = await renameEntryPath(arg),
          destination = await renameEntryPath(args[1]);
        await fs.rename(source, destination);
        return undefined;
      }
      case "file:makeDir": {
        if (typeof arg !== "string") throw Error("Directory creation requires a path");
        const input = arg.startsWith("file:") ? fileURLToPath(arg) : arg;
        if (!path.isAbsolute(input)) throw Error("Directory creation requires an absolute path");
        const recursive = args[1] === undefined ? true : args[1];
        if (typeof recursive !== "boolean") throw Error("Directory recursive flag must be boolean");
        const directory = await canonicalWritePath(input);
        await authorizePreviewPath(directory, args[2] || {});
        await fs.mkdir(directory, { recursive });
        return undefined;
      }
      case "file:writeBatch": {
        if (!Array.isArray(arg)) throw Error("File write batch requires an array");
        await Promise.all(
          arg.map((file) =>
            dispatch(
              "file:write",
              [file?.path, file?.data, file?.encoding || "utf-8", args[1] || {}],
              context,
            ),
          ),
        );
        return undefined;
      }
      case "file:write": {
        if (typeof arg !== "string" || typeof args[1] !== "string")
          throw Error("File write requires a path and text content");
        const input = arg.startsWith("file:") ? fileURLToPath(arg) : arg;
        if (!path.isAbsolute(input)) throw Error("File write requires an absolute path");
        const options = args[3] || {},
          encoding = args[2] || "utf-8";
        if (typeof encoding !== "string" || !Buffer.isEncoding(encoding))
          throw Error("Unsupported file write encoding");
        let filename = path.join(
          await canonicalWritePath(path.dirname(input)),
          path.basename(input),
        );
        await authorizePreviewPath(filename, options);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        filename = path.join(await fs.realpath(path.dirname(input)), path.basename(input));
        await authorizePreviewPath(filename, options);
        let mode = 0o600;
        try {
          const existing = await fs.lstat(filename);
          if (!existing.isFile() && !existing.isSymbolicLink())
            throw Error("File write requires a regular file");
          if (existing.isFile()) mode = existing.mode & 0o777;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const temporary = path.join(path.dirname(filename), `.wb-local-write-${randomUUID()}`);
        try {
          await fs.writeFile(temporary, args[1], { encoding, flag: "wx", mode });
          await fs.chmod(temporary, mode);
          await fs.rename(temporary, filename);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
        return undefined;
      }
      case "file:exists": {
        try {
          const filename =
            typeof arg === "string" && arg.startsWith("workbuddy-attachment:")
              ? await resolveUploadedAttachment(arg)
              : typeof arg === "string" && arg.startsWith("file:")
                ? fileURLToPath(arg)
                : arg;
          await fs.access(filename);
          return true;
        } catch {
          return false;
        }
      }
      case "file:getInfo": {
        const filename = await resolvePreviewPath(arg, args[1] || {});
        const stat = await fs.stat(filename);
        return {
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
        };
      }
      case "file:readChunked": {
        if (!arg || typeof arg !== "object") throw Error("Chunked preview requires parameters");
        const filename = await resolvePreviewPath(arg.filePath, { ...arg, ...(args[1] || {}) });
        const stat = await fs.stat(filename);
        if (!stat.isFile()) throw Error("File preview requires a regular file");
        const offset = arg.offset || 0,
          chunkSize = arg.chunkSize || 10 * 1024 * 1024;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(chunkSize) ||
          chunkSize <= 0
        )
          throw Error("Invalid chunk offset or size");
        const bytesToRead = Math.min(chunkSize, Math.max(0, stat.size - offset));
        if (!bytesToRead) return { data: "", bytesRead: 0, totalSize: stat.size, done: true };
        const handle = await fs.open(filename, "r");
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
          return {
            data: buffer.subarray(0, bytesRead).toString("base64"),
            bytesRead,
            totalSize: stat.size,
            done: offset + bytesRead >= stat.size,
          };
        } finally {
          await handle.close();
        }
      }
      case "file:read": {
        const filename = await resolvePreviewPath(arg, args[2] || {});
        const stat = await fs.stat(filename);
        if (!stat.isFile()) throw Error("File preview requires a regular file");
        const format = args[1] === "text" ? "utf-8" : args[1] || "utf-8";
        if (typeof format !== "string" || !Buffer.isEncoding(format))
          throw Error("Unsupported file read format");
        if (format === "base64" && stat.size > 50 * 1024 * 1024) {
          if (
            process.platform === "darwin" &&
            [
              ".png",
              ".jpg",
              ".jpeg",
              ".gif",
              ".webp",
              ".bmp",
              ".tiff",
              ".tif",
              ".heic",
              ".heif",
            ].includes(path.extname(filename).toLowerCase())
          ) {
            const output = path.join(
              require("node:os").tmpdir(),
              `wb-local-image-${randomUUID()}.jpeg`,
            );
            try {
              await require("node:util").promisify(require("node:child_process").execFile)(
                "/usr/bin/sips",
                [
                  "--resampleHeightWidthMax",
                  "2000",
                  "--setProperty",
                  "format",
                  "jpeg",
                  "--setProperty",
                  "formatOptions",
                  "80",
                  filename,
                  "--out",
                  output,
                ],
                { timeout: 120000 },
              );
              return (await fs.readFile(output)).toString("base64");
            } catch {
              // Preserve the original size error when native conversion fails.
            } finally {
              await fs.unlink(output).catch(() => {});
            }
          }
          const error = Error(
            `File is too large to read as base64 (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Maximum supported size is 50 MB.`,
          );
          error.code = "FILE_TOO_LARGE";
          error.fileSize = stat.size;
          throw error;
        }
        return (await fs.readFile(filename)).toString(format);
      }
      case "storage:getSessions":
        return (await rest("/sessions")).map(sessionSummary);
      case "wb:conversations:ensureList": {
        const list = await dispatch("wb:conversations:listScope", args);
        emit("wb:conversations:listProgress", { space: arg, list, traceId: args[1]?.traceId });
        return;
      }
      case "wb:conversations:listPinned":
        return (await rest("/sessions")).map(sessionSummary).filter(session => session.pinned).map(conversationInfo);
      case "wb:conversations:list":
      case "wb:conversations.local:list":
      case "wb:conversations:listScope": {
        const options = channel === "wb:conversations:listScope" ? args[1] || {} : arg || {};
        if (options.transport === "cloud" || channel === "wb:conversations:listScope" && arg !== "local" && arg !== "project")
          return { items: [], total: 0, page: { current: options.page || 1, size: options.size || 0 } };
        const sessions = (await rest("/sessions")).filter(session => !session.archived &&
          !(channel === "wb:conversations:listScope" && arg === "project" && !session.projectId));
        const size = Math.max(1, Math.min(1000, Number(options.size) || 100));
        const page = Math.max(1, Number(options.page) || 1);
        const items = sessions.map(session => conversationInfo(sessionSummary(session)))
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return { items: items.slice((page - 1) * size, page * size), total: items.length, page: { current: page, size } };
      }
      case "wb:conversations:get": {
        const id = typeof arg === "string" ? arg : arg?.conversationId || arg?.id;
        return conversationSnapshot(await dispatch("session:get", [id]));
      }
      case "wb:conversations:requestEntries":
      case "wb:conversations:requests": {
        const id = typeof arg === "string" ? arg : arg?.conversationId || arg?.id;
        const session = await rest("/sessions/" + encodeURIComponent(id));
        if (!session) throw Error("Session not found");
        const messages = await rest("/sessions/" + encodeURIComponent(id) + "/messages");
        const events = await rest("/sessions/" + encodeURIComponent(id) + "/events");
        const requests = textRequests(session, messages, events);
        if (channel === "wb:conversations:requestEntries") return requestEntries(requests, args[1]);
        const offset = Math.max(0, Math.floor(Number(args[1]) || 0));
        const size = Math.max(1, Math.min(1000, Math.floor(Number(args[2]) || 100)));
        const end = Math.max(0, requests.length - offset);
        return { items: requests.slice(Math.max(0, end - size), end), total: requests.length, page: Math.floor(offset / size) + 1 };
      }
      case "wb:conversations:getPendingInfo": {
        const pending = await pendingFor(typeof arg === "string" ? arg : arg?.conversationId);
        if (pending.length) throw Error("新版审批内容展示尚未适配");
        return undefined;
      }
      case "wb:conversations:queueItems":
        return (await dispatch("session:getMessageQueue", args)).items || [];
      case "wb:conversations:childAgentSnapshots": {
        const children = (await dispatch("session:getSubagentList", args)).subagents;
        if (children.length) throw Error("新版子代理历史尚未适配");
        return [];
      }
      case "wb:conversations:getCloudServiceConfirmation":
      case "wb:conversations:getPluginRecommendation": {
        if (!await rest("/sessions/" + encodeURIComponent(arg))) throw Error("Session not found");
        // These optional producers are not enabled in the local execution runtime.
        return undefined;
      }
      case "wb:conversations:configSetSandboxMode": {
        const session = await rest("/sessions/" + encodeURIComponent(arg));
        if (!session) throw Error("Session not found");
        if (args[1] !== false || session.config?.useSandboxCLI === true)
          throw Error("本地沙箱运行能力尚未接入");
        return;
      }
      case "wb:conversations:create": {
        const config = { ...arg?.config };
        for (const key of ["model", "mode", "expertId", "skillIds", "systemPrompt", "permissionMode"])
          if (arg?.[key] !== undefined) config[key] = arg[key];
        if (arg?.expert?.id) config.expertId = arg.expert.id;
        const session = await dispatch("session:create", [{ name: arg?.title || arg?.name, cwd: arg?.cwd || arg?.space?.cwd, config }]);
        return conversationSnapshot(session);
      }
      case "session:list": {
        let sessions = await rest("/sessions");
        for (const filter of arg?.filters || []) {
          if (filter.field !== "status" || typeof filter.value !== "string")
            throw Error("Unsupported session list filter");
          sessions = sessions.filter(session => session.status === filter.value);
        }
        if (arg?.sort?.orderBy === "updatedAt") {
          const direction = arg.sort.order === "asc" ? 1 : -1;
          sessions.sort((a, b) => direction * String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
        }
        return { agents: sessions.map(sessionSummary) };
      }
      case "storage:getWorkspaces":
        return (await rest("/workspaces")).map((item) => item.path);
      case "storage:getRecoveryNotice":
        return null;
      case "storage:upsertSession": {
        const id = arg.id || arg.sessionId;
        if (!id) throw Error("Session id required");
        return sessionSummary(
          await upsertSession(id, {
            ...arg,
            title: arg.name || arg.title,
            workspace: arg.cwd || arg.workspace,
          }),
        );
      }
      case "storage:deleteSession":
      case "session:delete": {
        const id = typeof arg === "string" ? arg : arg?.id || arg?.sessionId;
        await rest("/sessions/" + encodeURIComponent(id), "DELETE");
        emit("session:deleted", { sessionId: id, id });
        return { success: true };
      }
      case "session:create": {
        const config = arg?.config || {},
          global = await rest("/config");
        const session = await rest("/sessions", "POST", {
          title: arg?.name || "新任务",
          workspace:
            arg?.cwd || (settings.values.defaultWorkspacePath
              ? await dispatch("workspace:generateDefaultCwd", [])
              : global.workspace || await dispatch("workspace:generateDefaultCwd", [])),
          mode: config.mode === "ask" ? "ask" : "craft",
          model: String(config.model || global.model).replace(/^custom-local:/, ""),
          expertId: config.expertId || null,
          config: { ...config, permissionMode: "default", useSandboxCLI: false },
          skillIds: config.skillIds || [],
          systemPrompt: config.systemPrompt || "",
        });
        const summary = sessionSummary(session);
        emit("session:upserted", summary);
        return { ...summary, sessionId: session.id };
      }
      case "session:get":
      case "session:load": {
        const id = typeof arg === "string" ? arg : arg?.sessionId || arg?.id;
        let session = await rest("/sessions/" + encodeURIComponent(id));
        if (!session) throw Error("Session not found");
        if (!session.workspace) {
          session = await rest("/sessions/" + encodeURIComponent(id), "PUT", {
            workspace: await dispatch("workspace:generateDefaultCwd", []),
          });
          emit("session:upserted", sessionSummary(session));
        }
        const pending = await pendingFor(id);
        let replay = { complete: false, replayed: 0 };
        if (channel === "session:load") {
          replay = await replayTextHistory(id);
          pending.forEach((item) => pendingPermissionEvent(id, item));
          if (!pending.length)
            sessionEvent(id, {
              type: "promptResponse",
              response: { stopReason: "end_turn" },
              origin: "synthetic",
            });
        }
        return {
          ...sessionSummary(session),
          sessionId: id,
          rendererHistoryReplayComplete: replay.complete,
          replayTiming: { loadedCount: replay.replayed },
          configOptions: [],
          pendingPermissions: pending.map((item) => ({
            requestId: item.id,
            toolCallId: item.id,
            request: {
              sessionId: id,
              toolCall: {
                toolCallId: item.id,
                title: item.name,
                rawInput: rendererToolInput(item.name, item.args),
                _meta: rendererToolMetadata(item.name, item.args, true),
              },
              options: [
                { optionId: "allow_once", kind: "allow_once", name: "允许本次" },
                { optionId: "reject_once", kind: "reject_once", name: "拒绝" },
              ],
            },
          })),
          pendingQuestions: [],
        };
      }
      case "session:pin":
      case "session:unpin": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        if (typeof id !== "string" || !id) throw Error("任务 ID 必填");
        const session = await rest("/sessions/" + encodeURIComponent(id));
        if (!session?.id) throw Error("找不到任务");
        const ids = (settings.pinnedSessionIds || []).filter((item) => item !== id);
        settings.pinnedSessionIds = channel === "session:pin" ? [id, ...ids] : ids;
        await persist();
        emit("session:upserted", sessionSummary(session));
        return { success: true };
      }
      case "session:rename": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        const title = typeof arg === "string" ? args[1] : arg?.name || arg?.title;
        if (
          typeof id !== "string" ||
          !id ||
          !(await rest("/sessions/" + encodeURIComponent(id)))?.id
        )
          throw Error("找不到任务");
        if (typeof title !== "string" || !title.trim() || title.length > 1000)
          throw Error("任务名称必须为 1 至 1000 个字符");
        return upsertSession(id, {
          title,
          isUserDefinedTitle: 1,
        });
      }
      case "session:archive": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        if (typeof id !== "string" || !id) throw Error("任务 ID 必填");
        const session = await rest("/sessions/" + encodeURIComponent(id));
        if (!session?.id) throw Error("找不到任务");
        if (activePrompts.has(id) || ["running", "pending"].includes(session.status))
          throw Error("请先停止运行中的任务再归档");
        return upsertSession(id, { archived: true, status: "archived" });
      }
      case "session:updateStatus": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        const status = typeof arg === "string" ? args[1] : arg?.status;
        if (typeof id !== "string" || !id) throw Error("任务 ID 必填");
        const session = await rest("/sessions/" + encodeURIComponent(id));
        if (!session?.id) throw Error("找不到任务");
        if (status !== "completed" || session.status !== "archived")
          throw Error("此接口仅支持恢复归档任务，运行状态由执行器管理");
        return upsertSession(id, { archived: false, status: "completed" });
      }
      case "session:updateConfig":
        return updateSessionConfig(arg, args[1], args[3]);
      case "session:setConfigOption":
        return updateSessionConfig(arg, { [args[1]]: args[2] });
      case "session:setMode":
        return updateSessionConfig(arg, { mode: args[1] });
      case "session:setModel":
        return updateSessionConfig(arg, { model: args[1] });
      case "session:sendMessage":
        return promptSession(
          typeof arg === "string" ? arg : arg.sessionId,
          typeof arg === "string" ? args[1] : arg.prompt || arg.content,
          args[2] || arg._meta,
        );
      case "sandbox:respondToIntercept": {
        const id = arg.sessionId,
          requestId = arg.requestId,
          decision = String(arg.choice).startsWith("allow") ? "approve" : "deny";
        await rest("/approvals/" + encodeURIComponent(requestId), "POST", { decision });
        await setSessionStatus(id, activePrompts.has(id) ? "running" : "completed");
        const toolCallId = permissionTools.get(requestId) || requestId;
        emit("sandbox-intercept-resolved", {
          sessionId: id,
          requestId,
          toolCallId,
          choice: arg.choice,
        });
        sessionEvent(id, {
          type: "permissionResolved",
          requestId,
          toolCallId,
          decision: decision === "approve" ? "allow_once" : "reject_once",
        });
        return { success: true };
      }
      case "session:resolvePermission":
      case "session:rejectPermission": {
        const sessionId = typeof arg === "string" ? arg : arg.sessionId;
        const requestId = typeof arg === "string" ? args[1] : arg.requestId;
        const optionId = typeof arg === "string" ? args[2] : arg.optionId;
        const decision =
          channel === "session:resolvePermission" && String(optionId).startsWith("allow")
            ? "approve"
            : "deny";
        await rest("/approvals/" + encodeURIComponent(requestId), "POST", { decision });
        await setSessionStatus(sessionId, activePrompts.has(sessionId) ? "running" : "completed");
        sessionEvent(sessionId, {
          type: "permissionResolved",
          requestId,
          toolCallId: permissionTools.get(requestId) || requestId,
          decision: decision === "approve" ? "allow_once" : "reject_once",
        });
        return { success: true };
      }
      case "session:cancel": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        if (typeof id !== "string" || !id) throw Error("任务 ID 必填");
        if (!(await rest("/sessions/" + encodeURIComponent(id)))?.id) throw Error("找不到任务");
        const permissions = await pendingFor(id);
        cancelledSessions.add(id);
        const result = await rest("/sessions/" + encodeURIComponent(id) + "/cancel", "POST", {});
        for (const permission of permissions) {
          const toolCallId = permissionTools.get(permission.id) || permission.id;
          emit("sandbox-intercept-resolved", {
            sessionId: id,
            requestId: permission.id,
            toolCallId,
            choice: "reject_once",
          });
          sessionEvent(id, {
            type: "permissionResolved",
            requestId: permission.id,
            toolCallId,
            decision: "reject_once",
          });
          permissionTools.delete(permission.id);
        }
        await setSessionStatus(id, "cancelled");
        return result;
      }
      case "session:getAvailableCommands":
        return { availableCommands: [] };
      case "session:getSubagentList":
        return { subagents: [] };
      case "session:getTeamRuntime":
        return null;
      case "session:getMessageQueue":
        return (await rest("/sessions/" + encodeURIComponent(arg))).messageQueue || { items: [] };
      case "session:saveMessageQueue": {
        if (!arg || typeof arg !== "object" || typeof arg.conversationId !== "string" ||
            !arg.conversationId || !Array.isArray(arg.items) || !Number.isInteger(arg.version) || arg.version < 0)
          throw Error("A versioned conversation queue is required");
        const ids = new Set();
        for (const item of arg.items) {
          if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
              item.conversationId !== arg.conversationId || !Array.isArray(item.contentBlocks) ||
              !Number.isInteger(item.order) || item.order < 0 ||
              !["pending", "sending", "sent"].includes(item.status))
            throw Error("Invalid queue item or duplicate ID");
          ids.add(item.id);
        }
        await rest("/sessions/" + encodeURIComponent(arg.conversationId));
        const queue = structuredClone(arg);
        await rest("/sessions/" + encodeURIComponent(arg.conversationId), "PUT", { messageQueue: queue });
        sessionEvent(arg.conversationId, { update: { sessionUpdate: "session_info_update",
          _meta: { "codebuddy.ai/message_queue_update": queue } } });
        return undefined;
      }
      case "session:enqueueMessage": {
        const session = await rest("/sessions/" + encodeURIComponent(arg));
        const queue = session.messageQueue || {
          version: 0, conversationId: arg, updatedAt: Date.now(),
          runtime: { activated: false, paused: false, updatedAt: Date.now() }, items: [],
        };
        const contentBlocks = args[1];
        if (!Array.isArray(contentBlocks)) throw Error("contentBlocks array required");
        const now = Date.now();
        const firstText = contentBlocks.find((block) => typeof block === "string" || typeof block?.text === "string");
        queue.items.push({ id: randomUUID(), conversationId: arg, contentBlocks,
          previewText: (typeof firstText === "string" ? firstText : firstText?.text || "").slice(0, 100),
          status: "pending", order: queue.items.length ? Math.max(...queue.items.map((item) => item.order)) + 1 : 0,
          createdAt: now, updatedAt: now });
        queue.version++;
        queue.updatedAt = now;
        await rest("/sessions/" + encodeURIComponent(arg), "PUT", { messageQueue: queue });
        sessionEvent(arg, { update: { sessionUpdate: "session_info_update",
          _meta: { "codebuddy.ai/message_queue_update": queue } } });
        return queue;
      }
      case "session:getQueueState":
        return (await rest("/sessions/" + encodeURIComponent(arg))).messageQueue || { items: [] };
      case "session:removeQueueItem":
      case "session:popQueueItemForEdit":
      case "session:reorderQueue":
      case "session:pauseQueue":
      case "session:resumeQueue":
      case "session:activateQueue":
      case "session:sendQueueItemNow": {
        const session = await rest("/sessions/" + encodeURIComponent(arg));
        const queue = session.messageQueue || { version: 0, conversationId: arg,
          updatedAt: Date.now(), runtime: { activated: false, paused: false, updatedAt: Date.now() }, items: [] };
        let item;
        if (channel === "session:activateQueue") {
          queue.runtime ||= { activated: false, paused: false };
          if (queue.runtime.paused) return { item: undefined, queue };
          const immediateId = queue.runtime.immediateItemId;
          delete queue.runtime.immediateItemId;
          let index = immediateId ? queue.items.findIndex((entry) => entry.id === immediateId) : -1;
          if (index < 0) index = queue.items.findIndex((entry) => entry.status === "pending");
          if (index >= 0) { [item] = queue.items.splice(index, 1); queue.runtime.activated = true; }
        } else if (channel === "session:sendQueueItemNow") {
          queue.runtime ||= { activated: false, paused: false };
          const selected = queue.items.find((entry) => entry.id === args[1] && entry.status === "pending");
          if (selected) {
            queue.runtime.immediateItemId = selected.id;
            selected.status = "sending";
            selected.updatedAt = Date.now();
          }
        } else if (channel === "session:removeQueueItem" || channel === "session:popQueueItemForEdit") {
          item = queue.items.find((entry) => entry.id === args[1]);
          if (channel === "session:popQueueItemForEdit" && !item) return { item: undefined, queue };
          queue.items = queue.items.filter((entry) => entry.id !== args[1]);
        } else if (channel === "session:reorderQueue") {
          if (!Array.isArray(args[1]) || args[1].some((id) => typeof id !== "string"))
            throw Error("orderedIds must be an array of strings");
          const remaining = new Map(queue.items.map((entry) => [entry.id, entry]));
          const ordered = [];
          for (const id of args[1]) {
            if (remaining.has(id)) { ordered.push(remaining.get(id)); remaining.delete(id); }
          }
          ordered.push(...remaining.values());
          queue.items = ordered.map((entry, order) => ({ ...entry, order }));
        } else {
          queue.runtime ||= { activated: false };
          queue.runtime.paused = channel === "session:pauseQueue";
          queue.runtime.pauseReason = queue.runtime.paused ? args[1] : undefined;
          queue.runtime.updatedAt = Date.now();
        }
        queue.updatedAt = Date.now();
        queue.version++;
        await rest("/sessions/" + encodeURIComponent(arg), "PUT", { messageQueue: queue });
        sessionEvent(arg, { update: { sessionUpdate: "session_info_update",
          _meta: { "codebuddy.ai/message_queue_update": queue } } });
        return ["session:popQueueItemForEdit", "session:activateQueue", "session:sendQueueItemNow"].includes(channel) ? { item, queue } : queue;
      }
      case "session:getPersistedUsage":
      case "session:getLastUsageEvent":
        return null;
      case "session:notifyPermissionPendingApproval":
      case "session:notifyPermissionResolvedFromLocal": {
        const sessionId = arg,
          requestId = args[1];
        await rest("/sessions/" + encodeURIComponent(sessionId), "PUT", {
          permissionUiLastEvent: {
            requestId,
            type: channel,
            decision: args[2],
            updatedAt: new Date().toISOString(),
          },
        });
        return { recorded: true, source: "independent-local" };
      }
      case "session:notifyListenerReady": {
        const id = typeof arg === "string" ? arg : arg?.sessionId;
        const replay = await replayTextHistory(id);
        (await pendingFor(id)).forEach((item) => pendingPermissionEvent(id, item));
        return { ready: true, rendererHistoryReplayComplete: replay.complete };
      }
      case "workspace:generateDefaultCwd": {
        const base = await resolveDefaultWorkspaceRoot(arg?.root || settings.values.defaultWorkspacePath || path.join(homeDir, "WorkBuddy"), true);
        const directory = path.join(
          base,
          "task-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8),
        );
        await fs.mkdir(directory, { mode: 0o700 });
        return directory;
      }
      case "workspace:open": {
        const workspace = await rest("/workspaces", "POST", {
          path: typeof arg === "string" ? arg : arg?.path || arg?.cwd,
        });
        return { path: workspace.path, cwd: workspace.path };
      }
      case "workspace:checkPathExists": {
        try {
          return (await fs.stat(arg)).isDirectory();
        } catch (e) {
          if (e.code === "ENOENT") return false;
          throw e;
        }
      }
      case "workspace:checkPathsExist":
        return Object.fromEntries(
          await Promise.all(
            arg.map(async (p) => {
              try {
                return [p, (await fs.stat(p)).isDirectory()];
              } catch (error) {
                if (error.code === "ENOENT") return [p, false];
                throw error;
              }
            }),
          ),
        );
      case "expert:previewFromUrl":
      case "expert:importFromUrl": {
        if (typeof arg?.downloadUrl !== "string" || !arg.downloadUrl.trim())
          return {
            success: false,
            errorKey: "invalid_download_url",
            errorMessage: "Missing expert package download URL",
          };
        if (channel === "expert:importFromUrl" && arg.securityCheck === true)
          return {
            success: false,
            errorKey: "security_check_blocked",
            errorMessage: "本地版本尚未接入专家包安全扫描。",
          };
        const prepared = await prepareDownload(
          { skillName: arg.expertName || "expert-import", downloadUrl: arg.downloadUrl },
          { allowHttp: true },
        );
        if (!prepared.success)
          return {
            success: false,
            errorKey:
              prepared.errorKey === "invalidDownloadUrl"
                ? "invalid_download_url"
                : "download_failed",
            errorMessage: prepared.errorMessage,
          };
        try {
          if (channel === "expert:previewFromUrl") {
            const files = await require("./expert-zip.cjs").readExpertZip(
              prepared.downloadedFilePath,
            );
            const manifest = JSON.parse(
              files.get(require("./expert-zip.cjs").expertManifestPath(files)).toString("utf8"),
            );
            const avatar = (value) => {
              if (typeof value !== "string" || !value) return undefined;
              if (/^(https?:|data:)/i.test(value)) return value;
              const relative = path.posix.normalize(value.replace(/^\.\//, "").replace(/^\//, ""));
              const bytes = files.get(relative),
                mime =
                  {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".gif": "image/gif",
                    ".webp": "image/webp",
                    ".svg": "image/svg+xml",
                  }[path.posix.extname(relative).toLowerCase()] || "image/png";
              return bytes && mime ? `data:${mime};base64,${bytes.toString("base64")}` : undefined;
            };
            const metadata = {
              type: "expert",
              expertId: manifest.name,
              expertName:
                arg.expertName || manifest.profession || manifest.displayName || manifest.name,
            };
            for (const key of [
              "displayName",
              "profession",
              "description",
              "displayDescription",
              "author",
              "sharedBy",
              "categoryId",
              "categoryName",
              "expertType",
              "version",
              "tags",
              "skills",
              "quickPrompts",
              "teamInfo",
              "leader",
            ])
              if (manifest[key] !== undefined) metadata[key] = manifest[key];
            if (avatar(manifest.avatar)) metadata.avatar = avatar(manifest.avatar);
            const localizedList = require("./expert-zip.cjs").normalizeLocalizedManifestItems;
            for (const key of ["tags", "quickPrompts"])
              if (manifest[key] !== undefined) metadata[key] = localizedList(manifest[key]);
            if (manifest.members !== undefined)
              metadata.members = Array.isArray(manifest.members)
                ? manifest.members.map((member) =>
                    typeof member === "object" && member
                      ? { ...member,
                          ...(manifest.expertType === "team"
                            ? { id: require("./custom-experts.cjs").teamMemberId(member) } : {}),
                          avatar: avatar(member.avatar) }
                      : member,
                  )
                : [];
            let prompts = localizedList(manifest.triggerPrompts);
            if (prompts === undefined) prompts = localizedList(manifest.onboarding?.triggerPrompts);
            if (prompts === undefined && Array.isArray(manifest.onboarding?.triggerPrompt))
              prompts = manifest.onboarding.triggerPrompt;
            if (prompts === undefined && typeof manifest.onboarding?.triggerPrompt === "string")
              prompts = [manifest.onboarding.triggerPrompt];
            if (prompts !== undefined) metadata.triggerPrompts = prompts;
            return { success: true, metadata };
          }
          return await dispatch(
            "expert:installFromPath",
            [{ zipPath: prepared.downloadedFilePath, overwrite: arg.overwrite }],
            context,
          );
        } catch (error) {
          return {
            success: false,
            errorKey: /already exists/i.test(error.message)
              ? "duplicate_expert"
              : "invalid_package",
            errorMessage: error.message,
          };
        } finally {
          const downloaded = prepared.downloadedFilePath;
          const directory = path.basename(downloaded).startsWith("wb-local-skill-download-")
            ? downloaded
            : path.dirname(downloaded);
          if (
            path.basename(directory).startsWith("wb-local-skill-download-") &&
            path.dirname(directory) === require("node:os").tmpdir()
          )
            await fs.rm(directory, { recursive: true, force: true });
        }
      }
      case "expert:preCheckShare": {
        if (typeof arg?.zipPath !== "string" || !arg.zipPath)
          return { success: false, errorKey: "invalid_package", error: "Missing expert zip path" };
        if (arg.computeMd5Only !== true)
          return {
            success: false,
            errorKey: "security_unavailable",
            error: "本地版本尚未接入专家分享安全扫描服务。",
          };
        try {
          const filename = await fs.realpath(
            arg.zipPath.startsWith("file:") ? fileURLToPath(arg.zipPath) : arg.zipPath,
          );
          const privateRoot = await fs.realpath(dataDir);
          if (filename === privateRoot || filename.startsWith(privateRoot + path.sep))
            throw Error("Application private files cannot be hashed for sharing");
          if (!(await fs.stat(filename)).isFile())
            throw Error("Expert package must be a regular file");
          const hash = require("node:crypto").createHash("md5");
          for await (const chunk of require("node:fs").createReadStream(filename))
            hash.update(chunk);
          return { success: true, md5: hash.digest("hex"), selectedPath: arg.zipPath };
        } catch (error) {
          return { success: false, errorKey: "invalid_package", error: error.message };
        }
      }
      case "expert:clearCustomExpertSessionMarker": {
        await require("./custom-experts.cjs").clearCustomExpertSessionMarker(
          path.join(path.dirname(dataDir), "expert-config"),
          arg?.expertId,
        );
        await syncCustomExperts();
        return undefined;
      }
      case "expert:init":
        return { initialized: true, source: "local" };
      case "wb:experts:getPageLayout": {
        const categories = (await dispatch("expert:getCategories")).categories;
        const scenes = (await dispatch("expert:getFeaturedScenes")).scenes;
        const available = (await listAvailableExperts()).experts;
        const byId = new Map(available.map(expert => [expert.id, expert]));
        const subCategories = [{ displayName: { zh: "全部", en: "All" }, categoryId: "all", type: "all" },
          ...categories.map(category => ({ categoryId: category.id, displayName: category.name }))];
        return { featuredCategory: { id: "featured-common", type: "expert-featured", visible: true,
          displayName: { zh: "精选场景", en: "Featured Scene" },
          subCategories: scenes.map(scene => ({ categoryId: scene.id, displayName: scene.displayName,
            bgImage: scene.headerImage || scene.image, darkBgImage: scene.darkHeaderImage || scene.headerImage || scene.darkImage,
            experts: (scene.expertIds || []).map(id => byId.get(id)).filter(Boolean).map(sdkExpert) })) },
          expertsCategories: [
            { id: "expert", type: "expert", visible: true, displayName: { zh: "专家", en: "Experts" }, subCategories },
            { id: "expert-team", type: "expert-team", visible: true, displayName: { zh: "专家团", en: "Expert Teams" }, subCategories },
          ] };
      }
      case "wb:experts:getExpertPageLayout":
        return { version: 0 };
      case "wb:experts:categories":
      case "wb:experts.market:categories":
        return { items: (await dispatch("expert:getCategories")).categories };
      case "wb:experts:list":
      case "wb:experts.market:list":
      case "wb:experts.custom:list": {
        const result = await listAvailableExperts();
        const source = channel === "wb:experts.custom:list" ? "custom" : arg?.source;
        const keyword = String(arg?.keyword || "").toLocaleLowerCase();
        const experts = result.experts.filter(expert => {
          const custom = expert.isCustom || expert.source === "local-expert-package";
          return (!source || source === "all" || (source === "custom" ? custom : source === "builtin" ? !custom : false)) &&
            (!arg?.expertType || expert.expertType === arg.expertType) &&
            (!arg?.categoryId || arg.categoryId === "all" || expert.categoryId === arg.categoryId) &&
            (!keyword || JSON.stringify([expert.id, expert.name, expert.displayName, expert.profession, expert.description]).toLocaleLowerCase().includes(keyword));
        });
        const size = Math.max(1, Math.min(1000, Number(arg?.pageSize ?? arg?.limit) || 1000));
        const page = Math.max(1, Number(arg?.page) || 1);
        return { items: experts.slice((page - 1) * size, page * size).map(sdkExpert), total: experts.length,
          page: { current: page, size }, errors: result.errors };
      }
      case "wb:experts:get":
      case "wb:experts.custom:get":
        return sdkExpert(expertSummary(await findExpert(arg)));
      case "wb:experts.recents:list": {
        const items = await Promise.all(settings.expertHistory.map(async item => {
          try { return sdkExpert(expertSummary(await findExpert(item))); } catch { return null; }
        }));
        return { items: items.filter(Boolean) };
      }
      case "expert:getMarketCategories":
      case "expert:getCategories":
        return {
          categories: [
            ...(publicExpertCatalog ? (await require("./expert-catalog.cjs").catalog(origin)).categories : []),
            { id: "bundled-writing", name: { zh: "写作专家", en: "Writing experts" } },
            { id: "local", name: { zh: "本地专家", en: "Local experts" } },
          ],
        };
      case "expert:getMarketExperts": {
        const available = await listAvailableExperts();
        const all = available.experts,
          page = Math.max(1, Number(arg?.page) || 1),
          size = Math.max(1, Math.min(100, Number(arg?.page_size) || 100));
        return {
          experts: all.slice((page - 1) * size, page * size),
          total: all.length,
          page,
          page_size: size,
          errors: available.errors,
        };
      }
      case "expert:getExperts":
        return listAvailableExperts();
      case "expert:summonExpert": {
        const stored = await findExpert(arg);
        if (["local-expert-package", "public-expert-catalog"].includes(stored.source) && stored.expertType === "team")
          throw Error("当前本地版本尚未接入专家团执行，接入 DSH 后提供。");
        if (stored.source === "public-expert-catalog" && !stored.systemPrompt) {
          stored.systemPrompt = await require("./expert-catalog.cjs").instructions(stored, fetchImpl);
          await rest("/experts/" + encodeURIComponent(stored.id), "PUT", stored);
        }
        const
          summary = expertSummary(stored),
          locale = arg?.locale === "en" ? "en" : "zh";
        const localized = (value) =>
          typeof value === "string" ? value : value?.[locale] || value?.zh || value?.en || "";
        const prompt = localized(summary.prompt);
        if (!prompt.trim()) throw Error("本地专家没有可用指令：" + stored.id);
        const expert = {
          ...summary,
          name: localized(summary.name),
          profession: localized(summary.profession),
          prompt,
          defaultInitPrompt: localized(stored.defaultInitPrompt),
          avatarUrl: stored.avatarUrl || "",
          localPath: stored.resourcePath
            ? path.join(__dirname, "../desktop-resources", stored.resourcePath)
            : undefined,
        };
        settings.expertHistory = [
          {
            expertId: stored.id,
            expert,
            sessionId: arg?.sessionId,
            usedAt: new Date().toISOString(),
          },
          ...settings.expertHistory.filter((item) => item.expertId !== stored.id),
        ].slice(0, 30);
        await persist();
        return { expert };
      }
      case "expert:getExpert":
      case "expert:getCustomExpert":
        return { expert: expertSummary(await findExpert(arg)), loadState: "ready" };
      case "expert:installFromPath": {
        if (typeof arg?.zipPath !== "string" || !arg.zipPath)
          throw Error("Expert ZIP path required");
        const result = await require("./custom-experts.cjs").installCustomExpertZip(
          path.join(path.dirname(dataDir), "expert-config"),
          arg.zipPath,
          arg.overwrite === true,
        );
        await syncCustomExperts();
        return result;
      }
      case "expert:exportZip": {
        const expert = await findExpert(arg);
        if (expert.source !== "local-expert-package")
          throw Error("Only local expert packages can be exported");
        if (arg.expertRootDir && path.resolve(arg.expertRootDir) !== expert.expertRootDir)
          throw Error("Expert root does not match installed package");
        return require("./custom-experts.cjs").exportCustomExpert(
          path.join(path.dirname(dataDir), "expert-config"),
          expert.id,
          arg.shareAuthorName,
        );
      }
      case "expert:scanCustomExperts": {
        const scanned = await syncCustomExperts();
        return { experts: scanned.experts.map(expertSummary), errors: scanned.errors };
      }
      case "expert:getFeaturedScenes":
        return { scenes: publicExpertCatalog ? (await require("./expert-catalog.cjs").catalog(origin)).scenes : [] };
      case "expert:getAgentTemplates":
        return { templates: [] };
      case "expert:getRanking":
        return listAvailableExperts();
      case "expert:getUseRequirements":
        return { requiresLogin: false, source: "local" };
      case "expert:refresh":
        return listAvailableExperts();
      case "expert:deleteCustomExpert": {
        const expert = await findExpert(arg);
        let archived;
        if (expert.source === "local-expert-package")
          archived = await require("./custom-experts.cjs").archiveCustomExpert(
            path.join(path.dirname(dataDir), "expert-config"),
            expert.id,
          );
        try {
          await rest("/experts/" + encodeURIComponent(expert.id), "DELETE");
        } catch (error) {
          if (archived) await fs.rename(archived.archivedPath, archived.previousPath);
          throw error;
        }
        return { success: true };
      }
      case "expert:activatePlugin": {
        const id = arg?.pluginId || arg?.expertId || arg;
        try {
          const expert = await findExpert(id);
          if (expert.source !== "local-expert-package" || !expert.expertRootDir)
            throw Error(
              "Native expert plugin package is not installed; local instruction binding remains available",
            );
          const pluginRegisteredName = expert.id.replace(/^custom-expert:/, "");
          if (arg?.pluginName && arg.pluginName !== pluginRegisteredName)
            throw Error("Expert plugin name does not match installed package");
          await updateActiveExperts((previous) => [...new Set([...previous, id])]);
          return {
            success: true,
            expertType: expert.expertType || "agent",
            agentName: expert.agentName,
            localPath: expert.expertRootDir,
            pluginRegisteredName,
            version: expert.version || "",
            nativePluginRuntimeAvailable: false,
          };
        } catch (error) {
          return { success: false, expertType: "skill", error: error.message };
        }
      }
      case "expert:switchPluginForSession": {
        if (!arg?.sessionId) return undefined;
        await syncCustomExperts();
        const previous = await rest("/sessions/" + encodeURIComponent(arg.sessionId));
        const updated = await rest(
          "/sessions/" + encodeURIComponent(arg.sessionId) + "/expert-switch",
          "POST",
          { ...arg, expectedExpertId: previous.expertId || null },
        );
        emit("session:upserted", sessionSummary(updated));
        return undefined;
      }
      case "expert:deactivatePlugin": {
        const id = arg?.pluginId || arg?.expertId || arg;
        await updateActiveExperts((previous) => previous.filter((item) => item !== id));
        return undefined;
      }
      case "expert:getActivePlugins":
        await activeExpertMutations;
        return { experts: [...settings.activePlugins] };
      case "expert-history:getRecent":
        return settings.expertHistory;
      case "expert-history:add":
        settings.expertHistory = [
          arg,
          ...settings.expertHistory.filter((x) => x.expertId !== arg.expertId),
        ].slice(0, 30);
        await persist();
        return { success: true };
      case "expert-history:clear":
        settings.expertHistory = [];
        await persist();
        return { success: true };
      case "expert-history:remove":
        settings.expertHistory = settings.expertHistory.filter(
          (x) => x.expertId !== (arg?.expertId || arg),
        );
        await persist();
        return { success: true };
      case "skill:list": {
        const skills = await rest("/skills");
        const loaded = await Promise.allSettled(skills.map(reloadLocalSkill));
        return {
          results: loaded.filter(item => item.status === "fulfilled").map(item => skillSummary(item.value)),
          errors: loaded.flatMap((item, index) => item.status === "rejected" ? [{ id: skills[index].id, name: skills[index].name, message: item.reason.message }] : []),
        };
      }
      case "wb:skills:installed": {
        const result = await dispatch("skill:list", args, context);
        return { items: result.results
          .filter(skill => !arg?.excludePluginSkills || skill.source !== "plugin")
          .map(skill => ({ ...skill, ref: skill.filePath, slug: skill.name })), errors: result.errors };
      }
      case "skill:getSkillsVersion": {
        const result = await dispatch("skill:list", [], context);
        const fingerprint = createHash("sha256").update(JSON.stringify(result)).digest("hex");
        if (fingerprint !== skillsFingerprint) {
          skillsFingerprint = fingerprint;
          skillsVersion = Math.max(Date.now(), skillsVersion + 1);
        }
        return { version: skillsVersion };
      }
      case "skill:getContent":
      case "skill:content": {
        const skill = await reloadLocalSkill(await findSkill(arg));
        return { content: skill.content, name: skill.name, filePath: skillSummary(skill).filePath };
      }
      case "skill:toggle": {
        const skill = await findSkill(arg);
        if (arg.disable !== undefined && typeof arg.disable !== "boolean")
          throw Error("Skill disable must be boolean");
        const enabled =
          typeof arg.disable === "boolean" ? !arg.disable : (arg.enabled ?? !skill.enabled);
        let previous,
          filename,
          content = skill.content;
        if (skill.localRootDir) {
          const current = await dispatch("skill:content", [{ id: skill.id }]);
          filename = await fs.realpath(current.filePath);
          previous = current.content;
          content = setModelInvocationDisabled(previous, !enabled);
          await fs.writeFile(filename, content);
        }
        try {
          await rest("/skills/" + skill.id, "PUT", {
            enabled,
            disableModelInvocation: !enabled,
            content,
          });
        } catch (error) {
          if (filename) await fs.writeFile(filename, previous);
          throw error;
        }
        return { success: true };
      }
      case "skill:exportZip": {
        const skill = await findSkill({ name: arg?.skillName, id: arg?.skillId });
        const filePath = skillSummary(skill).filePath;
        let files;
        if (skill.resourcePath || skill.localRootDir) {
          const root = path.dirname(filePath);
          if (
            skill.localRootDir &&
            !(await fs.realpath(root)).startsWith(
              (await fs.realpath(path.join(dataDir, "skills"))) + path.sep,
            )
          )
            throw Error("Skill package escapes installed skills root");
          if (arg?.skillRootDir && path.resolve(arg.skillRootDir) !== path.resolve(root))
            throw Error("Skill root does not match installed package");
          files = await require("./custom-experts.cjs").collectPackageFiles(root);
        } else {
          if (arg?.skillRootDir && arg.skillRootDir !== filePath)
            throw Error("Skill has no installed directory");
          files = new Map([["SKILL.md", Buffer.from(skill.content || "", "utf8")]]);
        }
        if (!files.has("SKILL.md")) throw Error("Skill package requires SKILL.md");
        const exportsDir = path.join(dataDir, "skill-exports");
        await fs.mkdir(exportsDir, { recursive: true });
        if (!(await fs.realpath(exportsDir)).startsWith((await fs.realpath(dataDir)) + path.sep))
          throw Error("Skill export escapes data root");
        const zipPath = path.join(exportsDir, randomUUID() + ".zip");
        await fs.writeFile(zipPath, require("./expert-zip.cjs").createExpertZip(files), {
          flag: "wx",
          mode: 0o600,
        });
        return { success: true, zipPath };
      }
      case "skill:delete": {
        const skill = await findSkill(arg);
        await rest("/skills/" + skill.id, "DELETE");
        return { success: true };
      }
      case "skill:import":
      case "skill:installByPath": {
        if (channel === "skill:import" && arg?.securityCheck === true) {
          const error = new Error("本地版本尚未接入技能安全扫描，无法完成启用扫描的导入请求。");
          error.code = "LOCAL_SKILL_SCAN_UNAVAILABLE";
          throw error;
        }
        let content = arg?.content,
          filename = arg?.folderPath || arg?.filePath || arg?.path,
          packageFiles;
        if (!content && filename) {
          const stat = await fs.stat(filename);
          if (stat.isFile() && /\.zip$/i.test(filename)) {
            const files = await require("./expert-zip.cjs").readPackageZip(filename);
            const manifests = [...files.keys()].filter(
              (name) => name === "SKILL.md" || name.endsWith("/SKILL.md"),
            );
            if (manifests.length !== 1) throw Error("ZIP must contain exactly one skill package");
            const prefix = manifests[0].slice(0, -"SKILL.md".length);
            packageFiles = new Map();
            for (const [name, bytes] of files) {
              if (!name.startsWith(prefix)) throw Error("ZIP contains files outside skill package");
              packageFiles.set(name.slice(prefix.length), bytes);
            }
            if (packageFiles.get("SKILL.md").length > 1000000) throw Error("Skill exceeds 1 MB");
            content = packageFiles.get("SKILL.md").toString("utf8");
          } else if (stat.isDirectory()) {
            if ((await fs.lstat(filename)).isSymbolicLink())
              throw Error("Skill root cannot be a link");
            packageFiles = await require("./custom-experts.cjs").collectPackageFiles(filename);
            filename = path.join(filename, "SKILL.md");
          }
          if (!content) {
            if ((await fs.stat(filename)).size > 1000000) throw Error("Skill exceeds 1 MB");
            content = await fs.readFile(filename, "utf8");
          }
        }
        if (!content) throw Error("Skill content required");
        const name =
          arg?.name ||
          content.match(/^name:\s*(.+)$/m)?.[1] ||
          path.basename(filename || "本地技能").replace(/\.md$/i, "");
        const canonicalName = canonicalSkillName({ name, content });
        const duplicates = (await rest("/skills")).filter(
          (skill) => canonicalSkillName(skill) === canonicalName,
        );
        if (duplicates.length && arg?.overwrite !== true)
          return {
            success: false,
            errorKey: "duplicateSkillName",
            error: "duplicateSkillName",
            skillName: canonicalName,
          };
        if (duplicates.length > 1)
          throw Error("Multiple installed skills have this name; select a unique package first");
        if (duplicates[0]?.resourcePath)
          throw Error("Bundled skill packages cannot be overwritten by local import");
        let localRootDir;
        if (packageFiles) {
          const skillsRoot = path.join(dataDir, "skills");
          await fs.mkdir(skillsRoot, { recursive: true });
          if (!(await fs.realpath(skillsRoot)).startsWith((await fs.realpath(dataDir)) + path.sep))
            throw Error("Skill installation escapes data root");
          localRootDir = path.join(skillsRoot, randomUUID());
          for (const [relative, bytes] of packageFiles) {
            const target = path.join(localRootDir, relative);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
          }
        }
        const skill = await rest(
          duplicates.length ? "/skills/" + encodeURIComponent(duplicates[0].id) : "/skills",
          duplicates.length ? "PUT" : "POST",
          {
            name,
            content,
            enabled: skillFlags(content).disableModelInvocation !== true,
            ...skillFlags(content),
            localRootDir: localRootDir || null,
            source: "userSettings",
          },
        );
        return {
          success: true,
          skillName: canonicalSkillName(skill),
          skill: skillSummary(skill),
          results: [skillSummary(skill)],
        };
      }
      case "skill:getMarketplace":
        return { skills: [], source: "local" };
      case "builtin-market:list":
        return {
          code: 401,
          msg: "技能推荐市场需要 WorkBuddy 账号认证，当前本地账户尚未连接市场服务。",
          data: { total_count: 0, skills: [], source: "local_account_disconnected" },
        };
      case "builtin-market:categories":
        return { categories: [] };
      case "builtin-market:installedMetas":
        return [];
      case "plugin:listInstalled":
      case "plugin:getInstalled":
      case "plugin:getInstalledPlugins":
        await ensureSeed();
        return bundledPlugins.getInstalled();
      case "plugin:batchToggle":
      case "plugin:batchTogglePlugins":
        return bundledPlugins.batchToggle(arg);
      case "plugin:uninstall":
      case "plugin:uninstallPlugin":
        return bundledPlugins.uninstall(
          typeof arg === "string" ? arg : arg.pluginName,
          typeof arg === "string" ? args[1] : arg.marketplaceName,
          typeof arg === "string" ? args[2] : arg.scope,
        );
      case "plugin:install": {
        if (
          !Array.isArray(arg) ||
          args[1] !== bundledPlugins.marketplaceName ||
          (args[2] && args[2] !== "user")
        )
          throw Error("Only bundled-local user plugins can be restored by this local installer");
        for (const name of arg) await bundledPlugins.restore(name);
        return { success: true };
      }
      case "plugin:getMarketplacePlugins":
        return bundledPlugins.getMarketplacePlugins(arg, args[1], args[2]);
      case "plugin:getDetail":
      case "plugin:getPluginDetail":
        if (args[1] !== bundledPlugins.marketplaceName) throw Error("Unknown local marketplace");
        return (
          (await bundledPlugins.list({ includeUninstalled: true })).find(
            (item) => item.name === arg,
          ) || null
        );
      case "mcp:list":
        return (await rest("/connectors")).map((c) => ({
          ...c,
          serverName: c.name,
          name: c.name,
          status: c.disabled === true ? "disabled" : c.status || "disconnected",
          configSource: "user",
          enabled: c.disabled !== true,
        }));
      case "mcp:getConfigContent":
        return rest("/connectors/config");
      case "mcp:openConfig": {
        if (typeof openPath !== "function") throw Error("Desktop file opener unavailable");
        const document = await rest("/connectors/config");
        const expected = path.join(dataDir, "mcp.json");
        if (path.resolve(document.filePath) !== path.resolve(expected))
          throw Error("Unexpected MCP configuration path");
        const filename = await fs.realpath(expected);
        if (!filename.startsWith((await fs.realpath(dataDir)) + path.sep))
          throw Error("MCP configuration escapes application data root");
        const error = await openPath(filename);
        if (error) throw Error(error);
        return undefined;
      }
      case "mcp:saveConfigContent": {
        const { parseMcpConfig } = await import("../tools/mcp-config.mjs");
        const entries = parseMcpConfig(
          arg.content || '{"mcpServers":{}}',
          await rest("/connectors"),
        );
        await rest("/connectors/config", "PUT", { entries });
        return { success: true };
      }
      case "mcp:toggleTool": {
        if (
          typeof arg?.enabled !== "boolean" ||
          typeof arg.toolName !== "string" ||
          !arg.toolName.trim()
        )
          throw Error("MCP tool toggle requires tool name and enabled flag");
        const connector = (await rest("/connectors")).find(
          (c) => c.id === arg.serverName || c.name === arg.serverName,
        );
        if (!connector) throw Error("Connector not found");
        const disabled = new Set(connector.disabledTools || []);
        if (arg.enabled) disabled.delete(arg.toolName);
        else disabled.add(arg.toolName);
        await rest("/connectors/" + connector.id, "PUT", { disabledTools: [...disabled] });
        return undefined;
      }
      case "mcp:toggle": {
        if (typeof arg?.enabled !== "boolean") throw Error("MCP enabled must be boolean");
        const connector = (await rest("/connectors")).find(
          (c) => c.id === arg.serverName || c.name === arg.serverName,
        );
        if (!connector) throw Error("Connector not found");
        await rest("/connectors/" + connector.id, "PUT", { disabled: !arg.enabled });
        return undefined;
      }
      case "mcp:reconnect": {
        const connectors = await rest("/connectors");
        const c = connectors.find((c) => c.id === arg.serverName || c.name === arg.serverName);
        if (!c) throw Error("Connector not found");
        return rest("/connectors/" + c.id + "/connect", "POST", {});
      }
      case "mcp:delete": {
        const connectors = await rest("/connectors");
        const c = connectors.find((c) => c.id === arg.serverName || c.name === arg.serverName);
        if (!c) throw Error("Connector not found");
        return rest("/connectors/" + c.id, "DELETE");
      }
      case "connector:init":
        return { initialized: true, source: "local" };
      case "connector:getConfigs":
        return rest("/connectors");
      case "connector:getStates":
        return {};
      case "automation:archiveInboxItem": {
        if (typeof arg !== "string" || !arg) throw Error("运行记录 ID 必填");
        const run = await rest("/runs/" + encodeURIComponent(arg));
        if (!run?.id) throw Error("找不到运行记录");
        if (["running", "awaiting_approval"].includes(run.status))
          throw Error("运行中的记录不能归档");
        await rest("/runs/" + encodeURIComponent(arg), "PUT", {
          archived: true,
          archiveGroup: true,
          archivedAt: new Date().toISOString(),
        });
        return { success: true };
      }
      case "automation:deleteInboxItem": {
        if (typeof arg !== "string" || !arg) throw Error("运行记录 ID 必填");
        const run = await rest("/runs/" + encodeURIComponent(arg));
        if (!run?.id) throw Error("找不到运行记录");
        if (!run.archived) throw Error("请先归档运行记录再删除");
        if (["running", "awaiting_approval"].includes(run.status))
          throw Error("运行中的记录不能删除");
        await rest("/runs/" + encodeURIComponent(arg) + "?inbox=1", "DELETE");
        return { success: true };
      }
      case "automation:getSnapshot": {
        const automations = (await rest("/automations")).map((item) => ({
          ...item,
          cwds: item.cwds || (item.workspace ? [item.workspace] : []),
          status: item.status || (item.enabled ? "ACTIVE" : "PAUSED"),
          modelId: item.modelId || (item.model ? "custom-local:" + item.model : ""),
          skills: item.skills || item.skillIds || [],
        }));
        const runs = await rest("/runs");
        const groups = new Map();
        for (const run of runs) {
          const key = run.groupId || run.id;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(run);
        }
        const runtimeState = {};
        const inbox = [...groups.entries()].map(([groupId, children]) => {
          const run = children.find((item) => item.id === groupId) || children[0];
          const automation = automations.find((item) => item.id === run.automationId);
          const active = children.find((item) =>
            ["running", "awaiting_approval"].includes(item.status),
          );
          const running = !!active;
          const success = children.every((item) => item.status === "completed");
          if (running)
            runtimeState[run.automationId] = {
              running: true,
              runningConversationId: active.sessionId,
              runningStartedAt: Date.parse(active.createdAt),
            };
          return {
            ...run,
            id: groupId,
            archived: children.every((item) => item.archived === true),
            automationName: automation?.name || "本地任务",
            status: running ? "IN_PROGRESS" : success ? "COMPLETED" : "FAILED",
            success,
            summary: children
              .map((item) => item.output || item.error || "")
              .filter(Boolean)
              .join("\n"),
            startedAt: Date.parse(run.createdAt),
            finishedAt: running
              ? 0
              : Math.max(
                  ...children.map((item) => (item.finishedAt ? Date.parse(item.finishedAt) : 0)),
                ),
            runs: children.map((item) => ({
              cwd: item.workspace || automation?.workspace || automation?.cwds?.[0] || "",
              conversationId: item.sessionId,
              success: item.status === "completed",
              error: item.error,
              summary: item.output || "",
              startedAt: Date.parse(item.createdAt),
              finishedAt: item.finishedAt ? Date.parse(item.finishedAt) : 0,
            })),
          };
        });
        return { automations, inbox, runtimeState, updatedAt: Date.now() };
      }
      case "automation:update": {
        if (arg.pushToWeChat || arg.pushToWecomBot)
          throw Error("微信 / 企业微信未连接，不能保存推送任务");
        if (arg.cwds !== undefined) {
          if (!Array.isArray(arg.cwds)) throw Error("工作目录必须为数组");
          for (const directory of arg.cwds) {
            if (typeof directory !== "string" || !directory) throw Error("工作目录不能为空");
            try {
              if (!(await fs.stat(directory)).isDirectory()) throw Error("not directory");
            } catch {
              throw Error("工作目录不存在或不是目录：" + directory);
            }
          }
        }
        if (arg.connectorIds?.length) throw Error("本地自动化暂不支持原云连接器绑定");
        const skills = arg.skills?.length ? await rest("/skills") : [];
        const data = {
          ...arg,
          prompt: arg.prompt || arg.instructions,
          ...(arg.modelId !== undefined
            ? { model: String(arg.modelId).replace(/^custom-local:/, "") }
            : {}),
          ...(arg.cwds?.length ? { workspace: arg.cwds[0] } : {}),
          ...(arg.skills !== undefined
            ? { skillIds: arg.skills.map((reference) => resolveSkill(skills, reference).id) }
            : {}),
          ...(arg.status ? { enabled: arg.status === "ACTIVE" } : {}),
          mode: "craft",
        };
        if (arg.scheduleType) {
          const { validateCalendarSchedule } = await import("../tools/calendar-schedule.mjs");
          validateCalendarSchedule(data);
        }
        const automation = await rest(
          "/automations" + (arg.id ? "/" + arg.id : ""),
          arg.id ? "PUT" : "POST",
          data,
        );
        return { success: true, automation };
      }
      case "automation:delete":
        await rest("/automations/" + encodeURIComponent(arg?.id || arg), "DELETE");
        return { success: true };
      case "automation:test": {
        const run = await rest(
          "/automations/" + encodeURIComponent(arg?.id || arg) + "/run",
          "POST",
          {},
        );
        return { success: true, run, conversationId: run.sessionId };
      }
      case "memory:getProfile": {
        const memories = await rest("/memories");
        return {
          memories,
          memoryBlock: memories.map((item) => item.content).join("\n\n"),
          generateMemoryEnabled: (settings.values.generateMemoryEnabled ?? settings.values.memory?.generateMemoryEnabled) === true,
          localMemoryEnabled: (settings.values.localMemoryEnabled ?? settings.values.memory?.localMemoryEnabled) !== false,
          updatedAt: memories[0]?.updatedAt,
          source: "local",
        };
      }
      case "memory:importContent": {
        const content = typeof arg === "string" ? arg : arg?.content;
        if (typeof content !== "string" || !content.trim())
          throw Error("记忆内容不能为空，且必须为文本。");
        if (content.length > 100000) throw Error("记忆内容不能超过 100000 字符。");
        const imported = await rest("/memories", "POST", {
          name: typeof arg?.name === "string" && arg.name.trim() ? arg.name.trim() : "本地记忆",
          content: content.trim(),
        });
        return { success: true, imported: true, memory: imported };
      }
      case "memory:saveSettings": {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) throw Error("Memory settings must be an object");
        const allowed = ["generateMemoryEnabled", "localMemoryEnabled"];
        for (const key of Object.keys(arg))
          if (!allowed.includes(key) || typeof arg[key] !== "boolean") throw Error("Memory settings accept only boolean memory switches");
        const next = {
          generateMemoryEnabled: (settings.values.generateMemoryEnabled ?? settings.values.memory?.generateMemoryEnabled) === true,
          localMemoryEnabled: (settings.values.localMemoryEnabled ?? settings.values.memory?.localMemoryEnabled) !== false,
          ...arg,
        };
        const previous = Object.fromEntries(allowed.map(key => [key, { exists: Object.hasOwn(settings.values, key), value: settings.values[key] }]));
        Object.assign(settings.values, next);
        try { await persist(); } catch (error) {
          for (const key of allowed) {
            if (previous[key].exists) settings.values[key] = previous[key].value;
            else delete settings.values[key];
          }
          throw error;
        }
        for (const key of allowed) emit("config:changed", { key, value: next[key] });
        return { success: true, ...next, runtimeApplied: false, reason: "配置已保存，自动记忆执行待接入 DSH。" };
      }
      case "memory:submitSuggestion":
        return rest("/memory-profile/suggestion", "POST", arg);
      case "memory:clearProfile":
        for (const memory of await rest("/memories"))
          await rest("/memories/" + memory.id, "DELETE");
        return { success: true };
      case "memory:checkUpdating":
        return { updating: false, isUpdating: false };
      case "identity:getLocalMemoryFiles": {
        const user = await memoryFile("USER.md"),
          ai = await memoryFile("IDENTITY.md");
        const name = (file) => ({
          value: file.content.match(/^Name:\s*(.+)$/m)?.[1] || "",
          exists: file.exists,
          malformed: file.exists && !/^Name:\s*\S/m.test(file.content),
        });
        return {
          userCallName: name(user),
          aiName: name(ai),
          soul: await memoryFile("SOUL.md"),
          memory: await memoryFile("MEMORY.md"),
        };
      }
      case "identity:updateUserCallName":
        return saveIdentity("user", arg);
      case "identity:updateAiName":
        return saveIdentity("ai", arg);
      case "identity:updateSoulBody":
        return saveIdentity("soul", arg);
      case "identity:updateMemoryBody":
        return saveIdentity("memory", arg);
      case "auth:refreshSession":
        return { loggedIn: true, account: settings.account, source: "local" };
      case "proxySettings:getSettings":
        return { mode: "none", proxy: "", source: "local", available: false };
      case "plugin:getMarketplaces":
      case "plugin:getPluginMarketplaces":
        return bundledPlugins.getMarketplaces();
      case "enterprisePolicy:refreshSkillUploadPolicy":
        return { allowed: true, source: "local", cloudScanAvailable: false };
      case "builtin-market:migrateDirsToSkillId":
        return { migrated: 0, source: "local" };
      case "identity:getName":
        return { name: settings.localIdentity?.ai || "WorkBuddy Local", source: "local" };
      case "identity:updateName":
        settings.account.nickname = arg?.name || arg;
        await persist();
        emit("identity:changed", { name: settings.account.nickname });
        return { success: true, name: settings.account.nickname };
      case "window:getBundledRuntimeConfig": {
        const config = await rest("/config");
        return (
          config.bundledRuntime || {
            enabled: true,
            tools: { node: true, python: false, gitBash: false },
          }
        );
      }
      case "window:saveBundledRuntimeConfig": {
        const config = {
          enabled: arg?.enabled !== false,
          tools: {
            node: arg?.tools?.node !== false,
            python: arg?.tools?.python === true,
            gitBash: arg?.tools?.gitBash === true,
          },
        };
        if (config.tools.python || config.tools.gitBash) {
          const error = new Error(
            "独立包没有内置 Python 或 Git Bash；系统 Python 不属于内置依赖。",
          );
          error.code = "LOCAL_CAPABILITY_UNAVAILABLE";
          throw error;
        }
        const saved = await rest("/config", "PUT", { bundledRuntime: config });
        if (
          !saved.bundledRuntime ||
          saved.bundledRuntime.enabled !== config.enabled ||
          ["node", "python", "gitBash"].some(
            (key) => saved.bundledRuntime.tools?.[key] !== config.tools[key],
          )
        )
          unsupported(channel);
        return saved.bundledRuntime;
      }
      case "dataRetention:getDiskInfo": {
        const stat = await fs.statfs(dataDir),
          totalBytes = stat.blocks * stat.bsize,
          freeBytes = stat.bavail * stat.bsize;
        return { path: dataDir, totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
      }
      case "dataRetention:getStorageUsage": {
        let totalBytes = 0;
        const walk = async (directory) => {
          for (const item of await fs.readdir(directory, { withFileTypes: true })) {
            if (item.isSymbolicLink()) continue;
            const target = path.join(directory, item.name);
            if (item.isDirectory()) await walk(target);
            else if (item.isFile()) totalBytes += (await fs.stat(target)).size;
          }
        };
        await walk(dataDir);
        return { workbuddyRootDir: dataDir, totalBytes };
      }
      case "dataRetention:getPolicy":
        return { enabled: false, source: "local", automaticCleanup: false };
      case "dataRetention:getLastCleanupResult":
        return null;
      case "migration:getHistoryStatus":
        return { phase: "done", source: "independent-local", migrated: 0 };
      case "workspace:getCurrent": {
        const config = await rest("/config");
        return { cwd: config.workspace, path: config.workspace };
      }
      case "workspace:getClawCwd":
        return "";
      case "clawControl:getSnapshot":
        return {
          loaded: true,
          masterEnabled: true,
          channels: {},
          available: false,
          reason: "Local edition has no external messaging gateway",
        };
      case "claw:getWechatmpEnabled":
        return { enabled: false, source: "independent-local" };
      case "claw:getChannelStatus":
        return {
          statusMap: {},
          available: false,
          source: "independent-local",
          reason: "External messaging providers are not connected",
        };
      case "claw:getSavedChannelConfigs":
        return { configs: {}, source: "independent-local" };
      case "claw:getWecomEnabled":
      case "claw:getWechatmpArtifactUploadEnabled":
        return { enabled: false, available: false, source: "independent-local" };
      case "claw:getIsIOAMachine":
        return { isIOAMachine: false, source: "independent-local" };
      case "claw:getIOAImOverride":
        return { allowNonTencentIM: false, source: "independent-local" };
      case "claw:getAutomationWecomPushConfig":
        return {
          enabled: false,
          mode: "websocket",
          botId: "",
          available: false,
          source: "independent-local",
        };
      case "claw:wechatkfGetBindStatus":
        return {
          bound: false,
          available: false,
          source: "independent-local",
          reason: "External messaging provider is not connected",
        };
      case "cloudAssistant:getEntitlement":
        return {
          orchestratorEnabled: false,
          installed: false,
          teamsEnabled: false,
          available: false,
          reason: "Cloud service is not connected",
        };
      case "enterprisePolicy:getMemberCustomModelPolicy":
      case "enterprisePolicy:refreshMemberCustomModelPolicy":
        return { allowed: true, source: "independent-local", managed: false };
      case "connector:oauthStatus":
        return {
          status: "disconnected",
          authenticated: false,
          available: false,
          reason: "OAuth cloud providers are not connected",
        };
      case "ima:auth:status":
        return {
          authenticated: false,
          isAuthenticated: false,
          available: false,
          reason: "Cloud provider is not connected",
        };
      case "license:getSnapshot":
        return {
          source: "independent-local",
          status: "not_applicable",
          managed: false,
          usable: true,
          reason:
            "Independent local backend uses the user-configured model; vendor licensing is not applicable",
        };
      case "update:getState":
        return {
          state: "idle",
          status: "idle",
          autoUpdateEnabled: false,
          source: "independent-local",
        };
      case "slot:getActiveConfigs":
        return [];
      case "mcpApps:openHostApp":
        return rest("/connectors/apps/open", "POST", arg || {});
      case "mcpApps:closeHostApp":
        return rest("/connectors/apps/close", "POST", { appInstanceId: arg });
      case "mcpApps:getViewResource":
        return rest("/connectors/apps/view", "POST", { appInstanceId: arg });
      case "mcpApps:awaitBootstrapToolResult": {
        const result = await rest("/connectors/apps/await", "POST", { appInstanceId: arg });
        return result === null ? undefined : result;
      }
      case "mcpApps:refreshToolResult":
        return rest("/connectors/apps/refresh", "POST", { appInstanceId: arg, toolInput: args[1] });
      case "mcpApps:notifyToolCallUpdate":
        return rest("/connectors/apps/push-result", "POST", { toolCallId: arg, result: args[1] });
      case "mcpApps:notifyToolCall":
        return rest("/connectors/apps/notify-agent", "POST", arg || {});
      case "mcpApps:readResource":
        return rest("/connectors/apps/read", "POST", { appInstanceId: arg, uri: args[1] });
      case "mcpApps:callTool":
        return rest("/connectors/apps/call", "POST", {
          appInstanceId: arg,
          toolName: args[1],
          arguments: args[2],
        });
      case "mcpApps:listTools":
      case "mcpApps:listResources":
      case "mcpApps:listResourceTemplates":
      case "mcpApps:listPrompts": {
        const action = {
          "mcpApps:listTools": "tools",
          "mcpApps:listResources": "resources",
          "mcpApps:listResourceTemplates": "templates",
          "mcpApps:listPrompts": "prompts",
        }[channel];
        return rest("/connectors/apps/" + action, "POST", { appInstanceId: arg });
      }
      case "mcpApps:listApps":
        return rest("/connectors/apps");
      case "mcpApps:recordModelContextUpdate":
        return rest("/connectors/apps/record-context", "POST", {
          appInstanceId: arg,
          update: args[1],
        });
      case "mcpApps:getModelContextUpdate":
        return rest("/connectors/apps/get-context", "POST", { appInstanceId: arg });
      case "skillhub:installedMetas":
        return [];
      case "project:list":
        return [];
      case "idleCapability:getIdleCardData":
        return { candidates: [], source: "local" };
      case "msgCenter:getSummary":
        return { unreadCount: 0, total: 0, items: [], source: "local" };
      case "auth:getAmbassadorStatus":
        return { available: false, isAmbassador: false, reason: "No vendor account" };
      case "localExperts:getWatchPath":
        return path.join(__dirname, "../desktop-resources/vendor/experts");
      case "localDocs:setForegroundSession":
        settings.foregroundSession = arg;
        return { sessionId: arg, recorded: true };
      case "sessionRuntime:updateRouteState":
        settings.routeState = arg;
        return { recorded: true };
      case "securityCenter:getState":
        return {
          sandboxRules: settings.values.securityCenterRules?.sandbox || { allowedDomains: [], deniedDomains: [], denyAll: false },
          commandSafetyRules: settings.values.securityCenterRules?.commandSafety || null,
          fileSafetyRules: settings.values.securityCenterRules?.fileSafety || null,
          fileBackupConfig: settings.values.securityCenterRules?.fileBackup || null,
          sandboxEnabled: false,
          managed: false,
          dataSecurity: { securityGatewayEnabled: false, transmissionEncryptionEnabled: false },
          bundledRuntime: null,
          auditLog: { entries: [] },
          available: false,
          reason: "Commands require approval but are not isolated by a system sandbox",
        };
      case "securityCenter:saveSandboxRulesConfig": {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) throw Error("Rules object required");
        const previous = settings.values.securityCenterRules;
        const next = structuredClone(previous || {});
        for (const key of ["fileSafety", "commandSafety", "fileBackup"]) {
          if (Object.hasOwn(arg, key)) {
            if (arg[key] !== null && (typeof arg[key] !== "object" || Array.isArray(arg[key])))
              throw Error(`${key} must be an object or null`);
            if (arg[key] && key === "fileSafety") {
              for (const field of ["allowlist", "blocklist"])
                if (Object.hasOwn(arg[key], field) && (!Array.isArray(arg[key][field]) ||
                    arg[key][field].some((item) => typeof item !== "string" || !item.trim())))
                  throw Error(`${field} must contain nonempty strings`);
            }
            if (arg[key] && key === "commandSafety") {
              for (const field of ["ask", "allow"])
                if (Object.hasOwn(arg[key], field) && (!Array.isArray(arg[key][field]) ||
                    arg[key][field].some((rule) => !rule || !Array.isArray(rule.prefix) ||
                      rule.prefix.length === 0 || rule.prefix.some((part) => typeof part !== "string" || !part))))
                  throw Error(`${field} must contain command prefix rules`);
            }
            if (arg[key] && key === "fileBackup") {
              if (Object.hasOwn(arg[key], "enabled") && typeof arg[key].enabled !== "boolean")
                throw Error("Backup enabled must be boolean");
              if (Object.hasOwn(arg[key], "maxSizeMB") &&
                  (!Number.isFinite(arg[key].maxSizeMB) || arg[key].maxSizeMB <= 0))
                throw Error("Backup maxSizeMB must be positive");
            }
            next[key] = structuredClone(arg[key]);
          }
        }
        const sandbox = { ...(next.sandbox || {}) };
        for (const key of ["allowedDomains", "deniedDomains"]) {
          if (Object.hasOwn(arg, key)) {
            if (!Array.isArray(arg[key]) || arg[key].some((item) => typeof item !== "string"))
              throw Error(`${key} must be an array of strings`);
            sandbox[key] = [...arg[key]];
          }
        }
        if (Object.hasOwn(arg, "denyAll")) {
          if (typeof arg.denyAll !== "boolean") throw Error("denyAll must be boolean");
          sandbox.denyAll = arg.denyAll;
        }
        next.sandbox = sandbox;
        settings.values.securityCenterRules = next;
        try { await persist(); } catch (error) { settings.values.securityCenterRules = previous; throw error; }
        return { success: true, runtimeApplied: false, reason: "规则配置已保存，运行时执行待接入 DSH。" };
      }
      case "securityCenter:getExperimentalFeaturesConfig":
        return settings.values.experimentalFeatures || {};
      case "telemetry:report":
      case "telemetry:reportSync":
      case "telemetry:lifecycleLog":
        return { accepted: false, reason: "External telemetry disabled in local edition" };
      case "perf:flush":
      case "monitor:syncRendererSessionId":
      case "window:reportSessionRouteState":
        return { recorded: false, reason: "Local diagnostics only" };
      default:
        return unsupported(inputChannel);
    }
  }
  let modelQueue = Promise.resolve();
  const modelChannels = new Set([
    "auth:updateAccountNickname",
    "auth:getAccount",
    "auth:getUserInfo",
    "config:get",
    "config:getAll",
    "wb:config:setTheme",
    "appearance:setSelection",
    "config:set",
    "window:saveLocale",
    "window:saveDefaultWorkspacePath",
    "memory:saveSettings",
    "memory:getProfile",
    "config:saveLocalCustomModel",
    "config:deleteLocalCustomModel",
    "config:getLocalCustomModels",
    "config:getProductConfiguration",
    "models:list",
    "securityCenter:saveSandboxRulesConfig",
    "securityCenter:getState",
  ]);
  return (channel, args = [], context) => {
    if (["session:saveMessageQueue", "session:enqueueMessage", "session:removeQueueItem", "session:popQueueItemForEdit",
      "session:reorderQueue", "session:pauseQueue", "session:resumeQueue", "session:activateQueue",
      "session:sendQueueItemNow"].includes(aliases[channel] || channel)) {
      const profile = path.resolve(dataDir);
      const previous = messageQueueWritesByProfile.get(profile) || Promise.resolve();
      const operation = previous.then(() => dispatch(channel, args, context));
      const settled = operation.catch(() => {});
      messageQueueWritesByProfile.set(profile, settled);
      settled.then(() => {
        if (messageQueueWritesByProfile.get(profile) === settled) messageQueueWritesByProfile.delete(profile);
      });
      return operation;
    }
    if (!modelChannels.has(aliases[channel] || channel)) return dispatch(channel, args, context);
    const operation = modelQueue.then(() => dispatch(channel, args, context));
    modelQueue = operation.catch(() => {});
    return operation;
  };
}
module.exports = { createDispatcher };
