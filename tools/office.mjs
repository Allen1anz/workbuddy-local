import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const script = join(dirname(fileURLToPath(import.meta.url)), "office.py");
const formats = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Generate an office package into the application's artifact folder. */
export async function generateOffice(spec, artifactsDir, { signal } = {}) {
  if (!spec || !formats[spec.format]) throw new Error("支持的文件格式为 docx、xlsx 和 pptx。");
  if (typeof spec.title !== "string" || spec.title.length > 200)
    throw new Error("请填写不超过 200 字的文档标题。");
  const encoded = JSON.stringify(spec);
  if (Buffer.byteLength(encoded) > 2_000_000) throw new Error("文档内容超过 2 MB。");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const filename = `${id}.${spec.format}`;
  const output = join(artifactsDir, filename);
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.WORKSPACE_PYTHON || "python3", [script, output], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`文档生成失败：${stderr.trim() || `退出码 ${code}`}`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(encoded);
  });
  const result = {
    id,
    filename,
    title: spec.title,
    format: spec.format,
    bytes: (await stat(output)).size,
    createdAt: new Date().toISOString(),
    url: `/api/office/download/${filename}`,
  };
  await writeFile(join(artifactsDir, `${id}.json`), JSON.stringify(result), { mode: 0o600 });
  return result;
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

/** HTTP routes and an agent tool for portable document generation. */
export function officeExtension(dataDir) {
  const artifactsDir = join(dataDir, "artifacts");
  const tool = {
    definition: {
      type: "function",
      function: {
        name: "office_create",
        description:
          "Create a downloadable Word, Excel, or PowerPoint file. For Word provide paragraphs; for Excel provide rows of cell values; for PowerPoint provide slides with title and body. Does not edit an existing document.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            format: { type: "string", enum: ["docx", "xlsx", "pptx"] },
            title: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            rows: {
              type: "array",
              items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
            },
            slides: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  body: { type: "array", items: { type: "string" } },
                },
                required: ["title", "body"],
              },
            },
          },
          required: ["format", "title"],
        },
      },
    },
    requiresApproval: true,
    handler: async (args, context = {}) =>
      generateOffice(args, artifactsDir, { signal: context.signal }),
  };
  const routes = async (req, res, url, context) => {
    if (req.method === "POST" && url.pathname === "/api/office/export") {
      try {
        json(res, 201, await generateOffice(context.body, artifactsDir));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/office/artifacts") {
      await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
      const entries = (await readdir(artifactsDir)).filter((name) =>
        /^[a-f0-9-]{36}\.json$/.test(name),
      );
      const files = [];
      for (const name of entries) {
        try {
          files.push(JSON.parse(await readFile(join(artifactsDir, name), "utf8")));
        } catch {}
      }
      json(
        res,
        200,
        files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/office/download/")) {
      const filename = url.pathname.slice("/api/office/download/".length);
      if (!/^[a-f0-9-]{36}\.(docx|xlsx|pptx)$/.test(filename)) {
        json(res, 400, { error: "无效文件名。" });
        return true;
      }
      try {
        const metadata = JSON.parse(
          await readFile(join(artifactsDir, `${filename.slice(0, 36)}.json`), "utf8"),
        );
        const format = filename.split(".").at(-1);
        const title = metadata.title.replace(/[\x00-\x1f/\\]/g, "_");
        const file = join(artifactsDir, filename);
        res.writeHead(200, {
          "Content-Type": formats[format],
          "Content-Length": (await stat(file)).size,
          "Content-Disposition": `attachment; filename="document.${format}"; filename*=UTF-8''${encodeURIComponent(`${title}.${format}`)}`,
          "X-Content-Type-Options": "nosniff",
        });
        await pipeline(createReadStream(file), res);
      } catch (error) {
        if (!res.headersSent) json(res, 404, { error: "文件不存在。" });
        else res.destroy(error);
      }
      return true;
    }
    return false;
  };
  return { tool, routes };
}
