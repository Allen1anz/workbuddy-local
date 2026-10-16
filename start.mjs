import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "./workspace.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.WORKBUDDY_DATA_DIR || join(root, ".data"));
const port = Number(process.env.WORKBUDDY_PORT || 18721);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("WORKBUDDY_PORT must be a port number.");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const server = createWorkspaceServer({
  dataDir,
  staticDir: join(root, "public"),
});
server.on("error", (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`工作台已启动：http://127.0.0.1:${port}`);
  console.log(`本地数据：${dataDir}`);
  console.log("首次使用请在设置中配置模型接口，并选择工作区。");
});
function shutdown() {
  server.close();
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
