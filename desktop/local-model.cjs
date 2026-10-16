const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const defaults = {
  enabled: false,
  autostart: false,
  port: 18725,
  maxTokens: 1024,
  prefillStepSize: 512,
  promptCacheSize: 2,
  promptCacheBytes: 536870912,
  enableThinking: false,
};
function createLocalModelManager({
  dataDir,
  writeLog = () => {},
  emit = () => {},
  spawnProcess = spawn,
  request = fetch,
  startupTimeout = 180000,
  pollInterval = 500,
}) {
  const file = path.join(dataDir, "local-model.json");
  let config = { ...defaults },
    child = null,
    startPromise = null,
    stopPromise = null;
  let state = { status: "disabled", managed: false };
  const publish = (patch) => {
    state = { ...state, ...patch };
    emit("localModel:statusChanged", { ...state });
    return { ...state };
  };
  async function load() {
    try {
      config = { ...defaults, ...JSON.parse(await fs.readFile(file, "utf8")) };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return { ...config };
  }
  async function validate(value) {
    if (typeof value.enabled !== "boolean" || typeof value.autostart !== "boolean")
      throw Error("enabled/autostart must be boolean");
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535)
      throw Error("Local model port must be 1024–65535");
    for (const key of ["maxTokens", "prefillStepSize", "promptCacheSize", "promptCacheBytes"])
      if (!Number.isInteger(value[key]) || value[key] < 1)
        throw Error(key + " must be positive integer");
    if (
      value.maxTokens > 8192 ||
      value.prefillStepSize > 4096 ||
      value.promptCacheSize > 16 ||
      value.promptCacheBytes > 2147483648
    )
      throw Error("Local model resource limits exceed supported bounds");
    if (value.enableThinking !== false) throw Error("This local host uses enable_thinking:false");
    if (value.enabled) {
      if (!path.isAbsolute(value.python || "") || !path.isAbsolute(value.modelPath || ""))
        throw Error("Existing Python and model paths must be absolute");
      if (!(await fs.stat(value.python)).isFile()) throw Error("Python executable must be a file");
      await fs.access(value.python, 1);
      value.modelPath = await fs.realpath(value.modelPath);
      if (!(await fs.stat(value.modelPath)).isDirectory())
        throw Error("Model path must be directory");
      await fs.access(path.join(value.modelPath, "config.json"));
    }
    return value;
  }
  async function configure(input) {
    await load();
    if (child) throw Error("Stop the managed model before changing configuration");
    const next = { ...config };
    for (const key of [...Object.keys(defaults), "python", "modelPath"])
      if (input[key] !== undefined) next[key] = input[key];
    config = await validate(next);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    return publish({
      status: config.enabled ? "stopped" : "disabled",
      managed: false,
      baseURL: `http://127.0.0.1:${config.port}/v1`,
      model: config.modelPath,
    });
  }
  async function probe() {
    try {
      const r = await request(`http://127.0.0.1:${config.port}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!r.ok) return { reachable: true, matching: false };
      const json = await r.json();
      return {
        reachable: true,
        matching: json.data?.some((item) => item.id === config.modelPath) === true,
      };
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError")
        return { reachable: true, matching: false };
      return { reachable: false, matching: false };
    }
  }
  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await load();
      await validate(config);
      if (!config.enabled) return publish({ status: "disabled", managed: false });
      if (child) return { ...state };
      const existing = await probe();
      if (existing.reachable) {
        if (!existing.matching)
          throw Error("Local model port is occupied by another service or model");
        return publish({
          status: "ready",
          managed: false,
          baseURL: `http://127.0.0.1:${config.port}/v1`,
          model: config.modelPath,
        });
      }
      const cacheDir = path.join(dataDir, "local-model-cache");
      await fs.mkdir(path.join(cacheDir, "hub"), { recursive: true, mode: 0o700 });
      publish({
        status: "starting",
        managed: true,
        baseURL: `http://127.0.0.1:${config.port}/v1`,
        model: config.modelPath,
        error: null,
      });
      const args = [
        "-m",
        "mlx_lm",
        "server",
        "--model",
        config.modelPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(config.port),
        "--chat-template-args",
        '{"enable_thinking":false}',
        "--max-tokens",
        String(config.maxTokens),
        "--prefill-step-size",
        String(config.prefillStepSize),
        "--prompt-cache-size",
        String(config.promptCacheSize),
        "--prompt-cache-bytes",
        String(config.promptCacheBytes),
        "--log-level",
        "WARNING",
      ];
      const proc = spawnProcess(config.python, args, {
        cwd: cacheDir,
        detached: true,
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: process.env.HOME,
          LANG: process.env.LANG || "en_US.UTF-8",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HOME: process.env.HOME,
          HF_HUB_CACHE: path.join(cacheDir, "hub"),
          XDG_CACHE_HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc;
      proc.stdout?.on("data", (chunk) =>
        writeLog("local model " + chunk.toString().slice(0, 2000).trim()),
      );
      proc.stderr?.on("data", (chunk) =>
        writeLog("local model " + chunk.toString().slice(0, 2000).trim()),
      );
      let spawnError;
      proc.once("error", (error) => {
        spawnError = error;
      });
      proc.once("close", (code, signal) => {
        if (child === proc) {
          child = null;
          publish({
            status: stopPromise ? "stopped" : "failed",
            managed: false,
            error: stopPromise ? null : `MLX service exited (${code ?? signal})`,
          });
        }
      });
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child !== proc) throw Error(state.error || "Local model exited");
        const health = await probe();
        if (health.matching) return publish({ status: "ready", managed: true, pid: proc.pid });
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      await stop();
      throw Error("MLX service startup timed out");
    })()
      .catch(async (error) => {
        if (child) await stop();
        publish({ status: "failed", managed: false, pid: null, error: error.message });
        throw error;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    if (!child)
      return state.status === "ready" && !state.managed
        ? { ...state, notStoppedReason: "Service is externally managed" }
        : publish({ status: config.enabled ? "stopped" : "disabled", managed: false, pid: null });
    const proc = child;
    stopPromise = new Promise((resolve) => {
      const kill = (signal) => {
        try {
          process.kill(-proc.pid, signal);
        } catch {
          try {
            proc.kill(signal);
          } catch {}
        }
      };
      const timer = setTimeout(() => kill("SIGKILL"), 3000);
      proc.once("close", () => {
        clearTimeout(timer);
        child = null;
        resolve(publish({ status: "stopped", managed: false, pid: null, error: null }));
      });
      kill("SIGTERM");
    }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }
  async function autostart() {
    await load();
    return config.enabled && config.autostart
      ? start()
      : publish({ status: config.enabled ? "stopped" : "disabled", managed: false });
  }
  return {
    configure,
    start,
    stop,
    autostart,
    status: () => ({ ...state }),
    getConfiguration: async () => ({ ...(await load()) }),
    ownsProcess: () => !!child,
  };
}
module.exports = { createLocalModelManager };
