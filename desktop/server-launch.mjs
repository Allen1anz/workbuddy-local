import { createWorkspaceServer } from "../workspace.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { installOpenSkills } from "../tools/open-skills.mjs";
process.env.WORKBUDDY_RENDERER ||= "public";
const dataDir = process.env.WORKBUDDY_DATA_DIR;
const port = Number(process.env.WORKBUDDY_LOCAL_PORT || 18723);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("WORKBUDDY_LOCAL_PORT must be an integer from 1 to 65535");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const server = createWorkspaceServer({
  dataDir,
  initialSkills: process.env.WORKBUDDY_OPEN_SKILLS === "1" ? await installOpenSkills(dataDir) : [],
  staticFallback: process.env.WORKBUDDY_RENDERER !== "public",
  staticDir:
    process.env.WORKBUDDY_UI_DIR ||
    resolve(
      import.meta.dirname,
      process.env.WORKBUDDY_RENDERER === "public" ? "../public" : "../desktop-ui",
    ),
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Fixed local desktop port " +
          port +
          " is already occupied. Close the other instance or set WORKBUDDY_LOCAL_PORT explicitly."
      : error.message,
  );
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", async () => {
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const config = await (await fetch(origin + "/api/config")).json();
    if (!config.workspace && process.env.WORKBUDDY_DEFAULT_WORKSPACE) {
      await mkdir(process.env.WORKBUDDY_DEFAULT_WORKSPACE, { recursive: true, mode: 0o700 });
      const response = await fetch(origin + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: process.env.WORKBUDDY_DEFAULT_WORKSPACE }) });
      if (!response.ok) throw Error("默认工作目录设置失败");
    }
    let previous;
    try { previous = JSON.parse(await readFile(join(dataDir, "local-model-endpoint.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous && config.baseURL === previous.baseURL && config.model === "qwen3:1.7b") {
      const response = await fetch(origin + "/api/local-model/start", { method: "POST" });
      if (!response.ok) throw Error((await response.json()).error);
      const model = await response.json();
      await fetch(origin + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseURL: model.baseURL, apiKey: "" }) });
    }
  } catch (error) { console.error("首次配置：" + error.message); }
  console.log("WORKBUDDY_READY " + JSON.stringify({ port: server.address().port, dataDir }));
});
const stop = () => {
  server.stopLocalModel();
  server.close();
  server.closeAllConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
