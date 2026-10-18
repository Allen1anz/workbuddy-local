import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
const MODEL = "qwen3:1.7b";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A private, on-demand model server. Never attaches to the user's global Ollama. */
export function createOllamaRuntime({ dataDir, binary = process.env.WORKBUDDY_OLLAMA_BIN, spawnProcess = spawn, request = fetch } = {}) {
  let child, origin, startPromise, pullController, closing = false;
  let state = { available: Boolean(binary), status: "stopped", model: MODEL, progress: 0, message: "本地模型尚未启动" };
  const snapshot = () => ({ ...state, ...(origin ? { baseURL: origin + "/v1" } : {}) });
  async function start() {
    if (closing) throw Error("应用正在退出");
    if (child && origin) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!binary || !path.isAbsolute(binary)) throw Error("当前环境未打包本地模型运行器，请使用桌面安装版或配置模型接口。");
      await fs.access(binary, 1);
      const directory = path.join(dataDir, "local-model");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const portServer = net.createServer();
      await new Promise((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
      const port = portServer.address().port;
      await new Promise(resolve => portServer.close(resolve));
      origin = "http://127.0.0.1:" + port;
      state = { ...state, status: "starting", message: "正在启动本地模型服务", error: undefined };
      child = spawnProcess(binary, ["serve"], {
        cwd: directory, stdio: ["ignore", "ignore", "pipe"], detached: true,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: directory, TMPDIR: process.env.TMPDIR || "/tmp",
          OLLAMA_HOST: origin, OLLAMA_MODELS: path.join(directory, "models"), OLLAMA_NO_CLOUD: "1",
          OLLAMA_KEEP_ALIVE: "0", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_CONTEXT_LENGTH: "8192",
          OLLAMA_MAX_QUEUE: "4", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0",
        },
      });
      const processHandle = child;
      let errorText = "";
      processHandle.stderr?.on("data", bytes => { errorText = (errorText + bytes).slice(-2000); });
      processHandle.once("error", error => { state = { ...state, status: "error", error: error.message, message: "运行器启动失败" }; });
      processHandle.once("exit", () => {
        if (child !== processHandle) return;
        child = null; origin = undefined;
        state = { ...state, status: closing || state.status === "stopped" ? "stopped" : "error", message: "本地模型服务已停止", ...(closing ? {} : { error: errorText.slice(-500) }) };
      });
      for (let i = 0; i < 100; i++) {
        if (!child || state.status === "error") throw Error(state.error || "本地模型服务提前退出");
        try {
          const response = await request(origin + "/api/tags", { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            const result = await response.json();
            const installed = result.models?.some(model => model.name === MODEL);
            await fs.writeFile(path.join(dataDir, "local-model-endpoint.json"), JSON.stringify({ baseURL: origin + "/v1" }), { mode: 0o600 });
            state = { ...state, status: installed ? "ready" : "needs-download", message: installed ? "本地模型已就绪" : "尚未下载本地模型", progress: installed ? 100 : 0 };
            return;
          }
        } catch {}
        await delay(200);
      }
      stop(); throw Error("本地模型服务启动超时");
    })().finally(() => { startPromise = null; });
    return startPromise;
  }
  async function download() {
    if (pullController) return snapshot();
    await start();
    if (pullController) return snapshot();
    if (state.status === "ready") return snapshot();
    const controller = new AbortController(); pullController = controller;
    state = { ...state, status: "downloading", message: "准备下载约 1.4 GB 模型", progress: 0, error: undefined };
    (async () => {
      const response = await request(origin + "/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, stream: true }), signal: controller.signal });
      if (!response.ok) throw Error("模型下载失败 HTTP " + response.status);
      let buffer = "", success = false;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 1_000_000) throw Error("模型下载进度响应异常");
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const item = JSON.parse(line); if (item.error) throw Error(item.error);
          success ||= item.status === "success";
          state = { ...state, message: item.status || "正在下载", progress: item.total ? Math.min(99, Math.floor(100 * (item.completed || 0) / item.total)) : state.progress };
        }
      }
      if (buffer.trim()) { const item = JSON.parse(buffer); if (item.error) throw Error(item.error); success ||= item.status === "success"; }
      if (!success) throw Error("模型下载未返回完成状态，请重试续传");
      controller.signal.throwIfAborted();
      state = { ...state, status: "ready", progress: 100, message: "本地模型已就绪" };
    })().catch(error => {
      state = { ...state, status: controller.signal.aborted ? "stopped" : "error", message: controller.signal.aborted ? "下载已取消，可稍后重试续传" : "模型下载失败", error: controller.signal.aborted ? undefined : error.message };
    }).finally(() => { if (pullController === controller) pullController = null; });
    return snapshot();
  }
  function stop() {
    pullController?.abort();
    state = { ...state, status: "stopped", message: "本地模型服务已停止" };
    const proc = child; child = null; origin = undefined;
    if (proc?.pid) {
      try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
      const timer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }, 3000); timer.unref();
      proc.once("exit", () => clearTimeout(timer));
    }
    return snapshot();
  }
  const routes = async (req, res, url) => {
    if (!url.pathname.startsWith("/api/local-model/")) return false;
    const reply = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (req.method === "GET" && url.pathname === "/api/local-model/status") reply(200, snapshot());
      else if (req.method === "POST" && url.pathname === "/api/local-model/start") { await start(); reply(200, snapshot()); }
      else if (req.method === "POST" && url.pathname === "/api/local-model/download") reply(200, await download());
      else if (req.method === "POST" && url.pathname === "/api/local-model/stop") reply(200, stop());
      else reply(404, { error: "Unknown local model route" });
    } catch (error) { reply(400, { error: error.message }); }
    return true;
  };
  return { routes, start, download, stop, snapshot, close() { closing = true; stop(); } };
}
