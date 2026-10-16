/** Match the shipped AppResolver content and UI metadata selection. */
export function resolveMcpAppResource(result, resourceUri) {
  const contents = Array.isArray(result?.contents) ? result.contents : [];
  let selected;
  for (const entry of contents) {
    if (typeof entry.text === "string" && entry.text.length > 0) {
      selected = { html: entry.text, mimeType: entry.mimeType || "text/html;profile=mcp-app" };
      break;
    }
    if (typeof entry.blob === "string" && entry.blob.length > 0) {
      try {
        selected = {
          html: Buffer.from(entry.blob, "base64").toString("utf8"),
          mimeType: entry.mimeType || "text/html;profile=mcp-app",
        };
        break;
      } catch {}
    }
  }
  if (!selected) throw Error(`UI resource "${resourceUri}" contains no readable HTML body`);
  let uiMetadata;
  for (const entry of contents) {
    const meta = entry._meta;
    if (meta && typeof meta === "object" && meta.ui && typeof meta.ui === "object") {
      uiMetadata = meta.ui;
      break;
    }
  }
  return { ...selected, uiMetadata };
}

export function createMcpAppResourceResolver(readResource) {
  const cache = new Map();
  let revision = 0;
  return {
    async resolve(app, { bypassCache = false } = {}) {
      const key = JSON.stringify([app.mcpAppId, app.resourceUri]);
      if (!bypassCache && cache.has(key)) return cache.get(key).value;
      const started = revision;
      const value = resolveMcpAppResource(await readResource(app), app.resourceUri);
      if (started === revision) cache.set(key, { appId: app.mcpAppId, value });
      return value;
    },
    invalidate(appId) {
      revision++;
      if (!appId) cache.clear();
      else for (const [key, entry] of cache) if (entry.appId === appId) cache.delete(key);
    },
  };
}
