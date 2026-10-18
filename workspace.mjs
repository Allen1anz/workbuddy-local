import { createAppServer } from "./server/app.mjs";
import { officeExtension } from "./tools/office.mjs";
import { mcpExtension } from "./tools/mcp.mjs";
import { modelRoutes } from "./tools/model.mjs";
import { officeEditTools } from "./tools/office-edit.mjs";
import { teamTool } from "./tools/team.mjs";
import { previewExtension } from "./tools/preview.mjs";
import { filesRoutes } from "./tools/files.mjs";
import { bundledResourcesTool } from "./tools/bundled-resources.mjs";
import { createOllamaRuntime } from "./tools/ollama-runtime.mjs";

/** Assemble the same capabilities for normal and isolated acceptance instances. */
export function createWorkspaceServer({ dataDir, staticDir, staticFallback = false, initialSkills = [] }) {
  const office = officeExtension(dataDir);
  const mcp = mcpExtension(dataDir);
  const model = modelRoutes();
  const preview = previewExtension();
  const files = filesRoutes(dataDir);
  const localModel = createOllamaRuntime({ dataDir });
  const server = createAppServer({
    dataDir,
    staticDir,
    staticFallback,
    initialSkills,
    extraTools: [
      office.tool,
      ...officeEditTools(dataDir),
      ...mcp.tools,
      teamTool(),
      preview.tool,
      bundledResourcesTool(),
    ],
    extraRoutes: async (...args) =>
      (await localModel.routes(...args)) ||
      (await office.routes(...args)) ||
      (await mcp.routes(...args)) ||
      (await model(...args)) ||
      (await files(...args)),
  });
  server.on("close", preview.close);
  server.on("close", () => localModel.close());
  server.stopLocalModel = () => localModel.close();
  server.on("close", () => mcp.close().catch(() => {}));
  return server;
}
