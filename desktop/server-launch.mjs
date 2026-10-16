import { createWorkspaceServer } from "../workspace.mjs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
process.env.WORKBUDDY_RENDERER ||= "public";
const dataDir = process.env.WORKBUDDY_DATA_DIR;
const port = Number(process.env.WORKBUDDY_LOCAL_PORT || 18723);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("WORKBUDDY_LOCAL_PORT must be an integer from 1 to 65535");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const server = createWorkspaceServer({
  dataDir,
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
server.listen(port, "127.0.0.1", () =>
  console.log("WORKBUDDY_READY " + JSON.stringify({ port: server.address().port, dataDir })),
);
const stop = () => {
  server.close();
  server.closeAllConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
