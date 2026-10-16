import http from "node:http";
import { stat, readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/** Serve approved workspace sites from a separate, loopback-only origin. */
export function previewExtension() {
  const servers = new Map();
  const tool = {
    definition: {
      type: "function",
      function: {
        name: "workspace_preview",
        description:
          "Start a localhost-only preview of an HTML site directory in the selected workspace. Requires approval. Uses a separate origin from the workspace app. Does not publish files to the internet or start arbitrary build commands.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, entry: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    requiresApproval: true,
    handler: async ({ path, entry = "index.html" }, { safePath }) => {
      const directory = await realpath(await safePath(path));
      if (!(await stat(directory)).isDirectory()) throw new Error("预览路径必须为工作区中的目录。");
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\"))
        throw new Error("入口应为目录中的文件名。");
      const inside = (name) => name === directory || name.startsWith(directory + sep);
      const entryPath = await realpath(resolve(directory, entry));
      if (!inside(entryPath) || !(await stat(entryPath)).isFile())
        throw new Error("入口文件不存在或越界。");
      if (servers.has(directory)) return servers.get(directory).result;
      if (servers.size >= 4) throw new Error("已有 4 个活动预览；重启工作台后可清理。");
      const server = http.createServer(async (req, res) => {
        try {
          if (!["GET", "HEAD"].includes(req.method)) {
            res.writeHead(405);
            res.end();
            return;
          }
          if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) {
            res.writeHead(403);
            res.end();
            return;
          }
          const url = new URL(req.url, "http://localhost");
          const pathname = decodeURIComponent(url.pathname);
          const file = await realpath(
            resolve(directory, "." + (pathname === "/" ? "/" + entry : pathname)),
          );
          if (!inside(file)) {
            res.writeHead(403);
            res.end();
            return;
          }
          const info = await stat(file);
          if (!info.isFile() || info.size > 20_000_000) {
            res.writeHead(413);
            res.end();
            return;
          }
          const body = await readFile(file);
          res.writeHead(200, {
            "Content-Type": mime[extname(file)] || "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const result = {
        url: `http://127.0.0.1:${server.address().port}/`,
        path: directory,
        entry,
        scope: "localhost-only",
      };
      servers.set(directory, { server, result });
      return result;
    },
  };
  const close = () => {
    for (const { server } of servers.values()) {
      server.close();
      server.closeAllConnections();
    }
    servers.clear();
  };
  return { tool, close };
}
