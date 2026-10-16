import { randomUUID } from "node:crypto";
/** User-facing MCP config preserves credentials locally, unlike public inventory. */
export function formatMcpConfig(entries) {
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        entries.map((entry) => [
          entry.name,
          {
            ...(entry.transport === "stdio"
              ? {
                  command: entry.command,
                  args: entry.args || [],
                  ...(entry.env === undefined ? {} : { env: entry.env }),
                }
              : {
                  url: entry.url,
                  ...(entry.transport === "sse" ? { type: "sse" } : {}),
                  ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
                  ...(entry.headers === undefined ? {} : { headers: entry.headers }),
                }),
            ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
            ...(entry.disabledTools === undefined ? {} : { disabledTools: entry.disabledTools }),
          },
        ]),
      ),
    },
    null,
    2,
  );
}
export function parseMcpConfig(content, previous = []) {
  const config = JSON.parse(content);
  if (
    !config ||
    typeof config.mcpServers !== "object" ||
    !config.mcpServers ||
    Array.isArray(config.mcpServers)
  )
    throw Error("mcpServers must be an object");
  return Object.entries(config.mcpServers).map(([name, value]) => {
    if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid MCP server");
    const allowed = new Set([
      "command",
      "args",
      "env",
      "url",
      "apiKey",
      "headers",
      "type",
      "disabled",
      "disabledTools",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw Error("Unsupported MCP configuration field");
    if (value.command && value.url) throw Error("MCP command and URL cannot be combined");
    if (value.type && !["stdio", "http", "streamable-http", "sse"].includes(value.type))
      throw Error("Unsupported MCP transport");
    const existing = previous.find((entry) => entry.name === name),
      transport = value.command ? "stdio" : value.type === "sse" ? "sse" : "http";
    const result = {
      ...Object.fromEntries(
        Object.entries(existing || {}).filter(([key]) =>
          ["command", "args", "env", "url", "apiKey", "headers", "transport"].includes(key),
        ),
      ),
      name,
      id: existing?.id || randomUUID(),
      transport,
      disabled: value.disabled === true,
      disabledTools: value.disabledTools || [],
    };
    if (value.disabled !== undefined && typeof value.disabled !== "boolean")
      throw Error("disabled must be boolean");
    if (
      !Array.isArray(result.disabledTools) ||
      result.disabledTools.some((tool) => typeof tool !== "string" || !tool.trim())
    )
      throw Error("disabledTools must contain tool names");
    if (transport === "stdio") {
      if (typeof value.command !== "string" || !value.command.trim())
        throw Error("Missing MCP command");
      if (
        value.args !== undefined &&
        (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))
      )
        throw Error("Invalid MCP arguments");
      if (value.headers !== undefined) throw Error("stdio does not use HTTP headers");
      result.command = value.command;
      result.args = value.args || [];
      if (value.env !== undefined) {
        if (
          !value.env ||
          typeof value.env !== "object" ||
          Array.isArray(value.env) ||
          Object.values(value.env).some((v) => typeof v !== "string")
        )
          throw Error("Invalid MCP environment");
        result.env = value.env;
      }
      delete result.url;
      delete result.headers;
      delete result.apiKey;
    } else {
      const url = new URL(value.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw Error("Invalid MCP URL");
      result.url = url.href;
      if (value.headers !== undefined) {
        if (
          !value.headers ||
          typeof value.headers !== "object" ||
          Array.isArray(value.headers) ||
          Object.values(value.headers).some((v) => typeof v !== "string")
        )
          throw Error("Invalid MCP headers");
        new Headers(value.headers);
        result.headers = value.headers;
      }
      if (value.apiKey !== undefined) {
        if (typeof value.apiKey !== "string") throw Error("Invalid MCP API key");
        result.apiKey = value.apiKey;
      }
      delete result.command;
      delete result.args;
      delete result.env;
    }
    return result;
  });
}
