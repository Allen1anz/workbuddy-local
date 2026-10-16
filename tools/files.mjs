import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, relative, extname } from "node:path";
import { officeEditTools } from "./office-edit.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** User-driven file browsing/editing with optimistic conflict detection. */
export function filesRoutes(dataDir) {
  const officeReader = officeEditTools(dataDir).find(
    (tool) => tool.definition.function.name === "office_read",
  );
  return async (req, res, url, context) => {
    if (!["/api/files", "/api/files/content", "/api/files/office"].includes(url.pathname))
      return false;
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const workspace = context.config.workspace;
      const path = req.method === "PUT" ? context.body.path : url.searchParams.get("path") || ".";
      if (typeof path !== "string" || !path) throw new Error("请选择有效的文件路径。");
      if (url.pathname === "/api/files" && req.method === "GET") {
        const directory = await context.safePath(path);
        const entries = [];
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const item = {
            name: entry.name,
            path: relative(workspace, join(directory, entry.name)),
            type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
            size: null,
          };
          if (entry.isFile()) item.size = (await stat(join(directory, entry.name))).size;
          entries.push(item);
        }
        entries.sort(
          (a, b) =>
            (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) ||
            a.name.localeCompare(b.name),
        );
        json(200, { workspace, path, entries });
        return true;
      }
      if (url.pathname === "/api/files/office" && req.method === "GET") {
        json(200, await officeReader.handler({ path }, { safePath: context.safePath }));
        return true;
      }
      if (url.pathname === "/api/files/content" && req.method === "GET") {
        const file = await context.safePath(path),
          info = await stat(file);
        if (!info.isFile()) throw new Error("请选择文件。");
        if (info.size > 1_000_000) throw new Error("文本编辑器支持不超过 1 MB 的 UTF-8 文件。");
        if (
          [
            ".docx",
            ".xlsx",
            ".pptx",
            ".pdf",
            ".png",
            ".jpg",
            ".jpeg",
            ".zip",
            ".asar",
            ".sqlite",
            ".db",
          ].includes(extname(file).toLowerCase())
        )
          throw new Error("这类文件不能作为文本编辑。Office 文件可查看内容。");
        const bytes = await readFile(file);
        if (bytes.includes(0)) throw new Error("文件不是 UTF-8 文本。");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        json(200, {
          workspace,
          path,
          text,
          sha256: digest(bytes),
          truncated: false,
          bytes: bytes.length,
        });
        return true;
      }
      if (url.pathname === "/api/files/content" && req.method === "PUT") {
        const { content, expectedSha256, expectedWorkspace } = context.body;
        if (typeof expectedWorkspace !== "string" || expectedWorkspace !== workspace) {
          json(409, { error: "工作目录已更换，请重新打开文件。" });
          return true;
        }
        if (typeof content !== "string" || Buffer.byteLength(content) > 1_000_000)
          throw new Error("内容必须为不超过 1 MB 的文本。");
        const file = await context.safePath(path, true);
        let current = null;
        try {
          current = await readFile(file);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (current !== null && digest(current) !== expectedSha256) {
          json(409, { error: "文件已有其他修改，请重新打开后保存。" });
          return true;
        }
        if (current === null && expectedSha256 !== null) {
          json(409, { error: "文件已不存在，请重新打开。" });
          return true;
        }
        await mkdir(dirname(file), { recursive: true });
        await context.safePath(path, true);
        await writeFile(file, content);
        json(200, { ok: true, sha256: digest(content) });
        return true;
      }
      json(405, { error: "不支持此操作。" });
      return true;
    } catch (error) {
      json(error.code === "ENOENT" ? 404 : 400, { error: error.message });
      return true;
    }
  };
}
