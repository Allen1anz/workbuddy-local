const path = require("node:path");

// Build an explicit launch contract without inheriting account credentials.
function buildNativeRuntimePlan({ executable, cliPath, root, modelId, port, modelPort = 18725, pluginDirs = [] }) {
  for (const [name, value] of Object.entries({ executable, cliPath, root })) {
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error(`${name} must be an absolute path`);
  }
  if (typeof modelId !== "string" || !modelId.trim() || modelId.startsWith("custom-local:"))
    throw new Error("modelId must be the original model service ID");
  for (const value of [port, modelPort]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535)
      throw new Error("Ports must be integers between 1024 and 65535");
  }
  if (port === modelPort) throw new Error("Native gateway and model need different ports");
  if (!Array.isArray(pluginDirs) || pluginDirs.some((value) => typeof value !== "string" || !path.isAbsolute(value)))
    throw new Error("Plugin directories must be absolute paths");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  return {
    executable,
    args: [cliPath, "--serve", "--host", "127.0.0.1", "--port", String(port),
      "--no-session-persistence", "--setting-sources", "user", "--model", `custom-local:${modelId}`,
      ...(pluginDirs.length ? ["--plugin-dir", ...new Set(pluginDirs)] : [])],
    cwd: path.join(root, "workspace"),
    env: {
      HOME: home,
      TMPDIR: path.join(root, "tmp"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_RUN_AS_NODE: "1",
      WORKBUDDY_CONFIG_DIR: config,
      CODEBUDDY_CONFIG_DIR: config,
      DISABLE_AUTOUPDATER: "1",
      CODEBUDDY_GIT_REPO_SCAN_DISABLED: "1",
      CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
      CODEBUDDY_DISABLE_CRON: "1",
    },
    directories: [home, config, path.join(home, ".workbuddy"), path.join(root, "tmp"), path.join(root, "workspace")],
    settingsFiles: [path.join(config, "settings.json"), path.join(home, ".workbuddy", "settings.json")],
    settings: { "http.proxySupport": "off", "http.noProxy": "*" },
    models: {
      models: [{ id: modelId, name: "Local model", url: `http://127.0.0.1:${modelPort}/v1`,
        apiKey: "local-no-secret", supportsImages: false, supportsToolCall: true, trustLevel: "custom" }],
      availableModels: [modelId],
    },
    acpURL: `http://127.0.0.1:${port}/api/v1/acp`,
    requiresNetworkBoundary: true,
  };
}

module.exports = { buildNativeRuntimePlan };
