"use strict";
const fs = require("node:fs/promises"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const MARKETPLACE = "bundled-local";
function createBundledPlugins({
  dataDir,
  resourcesDir = path.join(__dirname, "../desktop-resources"),
  applySkillChanges,
} = {}) {
  if (!dataDir) throw Error("dataDir required");
  const stateFile = path.join(dataDir, "bundled-plugin-state.json");
  let tail = Promise.resolve();
  const serialized = (fn) => {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  };
  async function inventory() {
    const parent = path.join(resourcesDir, "vendor/plugins/workbuddy-builtin/builtin-plugins");
    const seed = JSON.parse(await fs.readFile(path.join(resourcesDir, "seed.json"), "utf8"));
    const plugins = [];
    for (const dir of (await fs.readdir(parent, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const root = path.join(parent, dir.name),
        manifest = JSON.parse(
          await fs.readFile(path.join(root, ".codebuddy-plugin/plugin.json"), "utf8"),
        );
      if (typeof manifest.name !== "string") throw Error("Invalid plugin manifest: " + dir.name);
      const prefix = path.relative(resourcesDir, root).split(path.sep).join("/") + "/";
      const skills = (seed.skills || [])
        .filter((s) => typeof s.resourcePath === "string" && s.resourcePath.startsWith(prefix))
        .map((s) => ({
          id: s.id,
          name: s.slug || s.name,
          resourcePath: s.resourcePath,
          filePath: path.join(resourcesDir, s.resourcePath),
        }));
      plugins.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || "",
        author: manifest.author,
        marketplaceName: MARKETPLACE,
        scope: "user",
        installPath: root,
        skills,
        resourcePath: prefix.slice(0, -1),
        source: "bundled-client-resource",
        runtimeAvailable: false,
        runtimeUnavailableReason:
          "Bundled resources only. Original native engines, remote authorization, MCP programs and hooks are not activated by installation state.",
        declaredMcpServers: Object.keys(manifest.mcpServers || {}),
        declaredHooks: manifest.hooks || null,
      });
    }
    return plugins;
  }
  async function loadState() {
    try {
      return JSON.parse(await fs.readFile(stateFile, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  }
  async function saveState(state) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temp = stateFile + "." + randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temp, stateFile);
  }
  async function list({ includeUninstalled = false } = {}) {
    const [plugins, state] = await Promise.all([inventory(), loadState()]);
    return plugins.map((p) => {
      const uninstalled = state[p.name]?.uninstalled === true;
      const enabled = !uninstalled && state[p.name]?.enabled !== false;
      return {...p,enabled,uninstalled,installed:!uninstalled,status:uninstalled?"not-installed":enabled?"enabled":"disabled",installedPath:uninstalled?undefined:p.installPath,installedScopes:uninstalled?[]:["user"],installedScopesStatus:uninstalled?{}:{user:enabled},hasUpdate:false};
    }).filter((p) => includeUninstalled || !p.uninstalled);
  }
  async function change(
    pluginName,
    { enabled, uninstalled },
    marketplaceName = MARKETPLACE,
    scope = "user",
  ) {
    if (marketplaceName && marketplaceName !== MARKETPLACE)
      throw Error("Unknown local marketplace");
    if (scope && scope !== "user") throw Error("Bundled plugins support user scope only");
    const plugin = (await inventory()).find((p) => p.name === pluginName);
    if (!plugin) throw Error("Unknown bundled plugin: " + pluginName);
    const state = await loadState(),
      previous = state[pluginName] || { enabled: true, uninstalled: false };
    const next = { ...previous, enabled, uninstalled, updatedAt: new Date().toISOString() };
    const changes = plugin.skills.map((s) => ({
      id: s.id,
      enabled: enabled && !uninstalled,
      resourcePath: s.resourcePath,
    }));
    if (changes.length && !applySkillChanges)
      throw Error("Child skill adapter required; plugin state was not changed");
    // The caller must persist these child states; never advertise enabled while they remain disabled.
    if (changes.length)
      await applySkillChanges(changes, {
        pluginName,
        operation: uninstalled ? "uninstall" : enabled ? "enable" : "disable",
      });
    try {
      state[pluginName] = next;
      await saveState(state);
    } catch (error) {
      if (changes.length)
        await applySkillChanges(
          plugin.skills.map((s) => ({
            id: s.id,
            enabled: previous.enabled && !previous.uninstalled,
            resourcePath: s.resourcePath,
          })),
          { pluginName, operation: "rollback" },
        );
      throw error;
    }
    return plugin;
  }
  const batchToggle = (request) =>
    serialized(async () => {
      const succeededPlugins = [],
        failedPlugins = [];
      if (!Array.isArray(request?.items)) throw Error("items array required");
      for (const item of request.items) {
        const scope = item.scope || "user";
        try {
          if (!["enable", "disable"].includes(item.operation))
            throw Error("operation must be enable or disable");
          const entry = (await list({ includeUninstalled: true })).find(
            (p) => p.name === item.pluginName,
          );
          if (entry?.uninstalled) throw Error("Plugin uninstalled; restore installation first");
          await change(
            item.pluginName,
            { enabled: item.operation === "enable", uninstalled: false },
            item.marketplaceName,
            scope,
          );
          succeededPlugins.push({
            pluginName: item.pluginName,
            marketplaceName: item.marketplaceName || MARKETPLACE,
            scope,
            operation: item.operation,
          });
        } catch (e) {
          failedPlugins.push({ ...item, scope, error: e.message });
        }
      }
      return { success: failedPlugins.length === 0, succeededPlugins, failedPlugins };
    });
  const uninstall = (pluginName, marketplaceName, scope) =>
    serialized(async () => {
      await change(pluginName, { enabled: false, uninstalled: true }, marketplaceName, scope);
      return { success: true };
    });
  const restore = (pluginName) =>
    serialized(async () => {
      await change(pluginName, { enabled: true, uninstalled: false });
      return { success: true };
    });
  const getMarketplaces = async () => [{id:MARKETPLACE,name:MARKETPLACE,type:"local",source:{source:"directory",path:path.join(resourcesDir,"vendor/plugins/workbuddy-builtin/builtin-plugins")},installLocation:path.join(resourcesDir,"vendor/plugins/workbuddy-builtin/builtin-plugins"),description:"Local bundled resources; original runtime dependencies are not connected.",isBuiltIn:true,autoUpdate:false}];
  const getMarketplacePlugins = async (marketplaceName,forceRefresh=false,searchText) => {
    if(marketplaceName!==MARKETPLACE)throw Error("Unknown local marketplace");
    return (await list({includeUninstalled:true})).filter(p=>!searchText||(p.name+" "+p.description).toLowerCase().includes(String(searchText).toLowerCase()));
  };
  return {
    list,
    getInstalled: () => list(),
    getMarketplaces,
    getMarketplacePlugins,
    batchToggle,
    uninstall,
    restore,
    stateFile,
    marketplaceName: MARKETPLACE,
  };
}
module.exports = { createBundledPlugins, MARKETPLACE };
