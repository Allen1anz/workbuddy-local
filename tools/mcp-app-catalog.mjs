/** Catalog entries follow the shipped MCP Apps metadata contract. */
export function extractToolUiMetadata(tool) {
  const meta = tool?._meta;
  if (!meta || typeof meta !== "object") return;
  const ui = meta.ui;
  if (ui && typeof ui === "object") {
    const resourceUri = typeof ui.resourceUri === "string" ? ui.resourceUri : undefined;
    const visibility = Array.isArray(ui.visibility)
      ? ui.visibility.filter((v) => v === "model" || v === "app")
      : undefined;
    if (resourceUri) return { resourceUri, visibility };
  }
  const flat = meta["ui/resourceUri"];
  if (typeof flat === "string" && flat.length > 0) return { resourceUri: flat };
}

export function buildMcpAppCatalog(entries) {
  const apps = new Map();
  for (const { configId, tools } of entries) {
    const serverId = configId ? configId.slice(configId.indexOf(":") + 1) : "unknown";
    for (const tool of tools || []) {
      const ui = extractToolUiMetadata(tool);
      if (!ui?.resourceUri) continue;
      const toolName = tool.originalName || tool.name;
      const mcpAppId = `${serverId}/${toolName}`;
      apps.set(mcpAppId, {
        mcpAppId,
        mcpAppName: mcpAppId,
        serverId,
        prefixedToolName: tool.name,
        toolName,
        resourceUri: ui.resourceUri,
        description: tool.description,
        visibility: ui.visibility?.length ? ui.visibility : ["model", "app"],
        toolMeta: tool._meta,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return [...apps.values()];
}
