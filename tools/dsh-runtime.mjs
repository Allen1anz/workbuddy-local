import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function readDshConfiguration(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, "dsh-runtime.json"), "utf8"));
    if (!value.enabled) return null;
    if (!path.isAbsolute(value.repository || "")) throw Error("DSH仓库路径必须为绝对路径。");
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// One SDK runtime owns one turn. Closing it cancels only this product session.
export async function runDshTurn({ repository, dataDir, sessionId, workspace, model, baseURL, apiKey,
  system, message, tools = [], executeTool, signal, onEvent = () => {} }) {
  signal?.throwIfAborted();
  const clientPath = path.join(repository, "packages/sdk/client/lib/index.js");
  const cliPath = path.join(repository, "apps/cli/lib/bin.js");
  await Promise.all([fs.access(clientPath), fs.access(cliPath)]);
  const { DeepSeekHarness } = await import(pathToFileURL(clientPath).href);
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  const home = path.join(dataDir, "dsh", sessionKey);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const allowed = new Set(tools.map(tool => tool.function.name));
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from("Bearer " + token);
    if (req.method !== "POST" || req.url !== "/tool" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(403, { error: "Forbidden" });
    const requestController = new AbortController();
    const disconnect = () => { if (!res.writableEnded) requestController.abort(); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    try {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw Error("Tool request too large"); }
      const call = JSON.parse(raw);
      if (!allowed.has(call.name) || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) throw Error("Unregistered tool or invalid arguments");
      signal?.throwIfAborted();
      reply(200, await executeTool(call.name, call.args, signal ? AbortSignal.any([signal, requestController.signal]) : requestController.signal));
    } catch (error) { if (!res.destroyed) reply(400, { error: error.message }); }
    finally { req.off("aborted", disconnect); res.off("close", disconnect); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let harness;
  const close = () => { void harness?.close().catch(() => {}); };
  try {
    const patch = [
      ...["llm-deepseek", "deepseek-llm-api-extensions", "session-log-deepseek", "plugin-package-inventory-deepseek", "persistent-bash", "persistent-pwsh", "sdk-jsonrpc-server"].map(id => ({ id, disabled: true })),
      { id: "system-prompt", config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: system } },
      { insert: [
        { id: "workbuddy-sdk", name: pathToFileURL(path.join(import.meta.dirname, "dsh-product-sdk.mjs")).href, config: { repository } },
        { id: "workbuddy-model", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { "workbuddy-local": {
          api: "openai-completions", baseURL, apiKeyEnv: "WB_DSH_MODEL_KEY", defaultMaxTokens: 1024,
          retryPolicy: { mode: "normal", maxRetries: 0 }, models: [{ id: model, contextWindow: 32768, maxTokens: 1024, reasoningEfforts: false }],
        } } } },
        { id: "workbuddy-tools", name: pathToFileURL(path.join(import.meta.dirname, "dsh-product-tools.mjs")).href,
          config: { tools: tools.map(tool => tool.function) } },
      ] },
    ];
    const patchPath = path.join(home, "product.patch.json");
    await fs.writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 });
    const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { WB_DSH_MODEL_KEY: apiKey || "local", WB_DSH_TOOL_TOKEN: token, WB_DSH_TOOL_ENDPOINT: `http://127.0.0.1:${server.address().port}/tool` });
    harness = new DeepSeekHarness({ dshBin: cliPath, profile: "sdk-minimal", patches: [patchPath], dshHome: home,
      processCwd: workspace, cwd: workspace, provider: "workbuddy-local", model, env, maxTokens: 1024,
      initializeTimeoutMs: 30000, disposeEofGraceMs: 2000, disposeGraceMs: 2000 });
    signal?.addEventListener("abort", close, { once: true });
    signal?.throwIfAborted();
    const result = await harness.run(message, { sessionId, onNotification: onEvent });
    signal?.throwIfAborted();
    const end = result.events.filter(event => event.type === "turn/end").at(-1);
    if (end?.data?.reason?.kind !== "completed" || !result.finalResponse.trim()) throw Error("DSH未完成有效回复。");
    return result;
  } finally {
    signal?.removeEventListener("abort", close);
    try { await harness?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
