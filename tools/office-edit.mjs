import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "office-inspect.py");

async function run(source, spec, output, signal) {
  if (![".docx", ".xlsx", ".pptx"].includes(extname(source).toLowerCase()))
    throw new Error("仅支持 docx、xlsx、pptx。");
  if ((await stat(source)).size > 64_000_000) throw new Error("文档超过 64 MB。");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.WORKSPACE_PYTHON || "python3",
      [script, source, ...(output ? [output] : [])],
      { stdio: ["pipe", "pipe", "pipe"], signal, timeout: 30_000 },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`文档处理失败：${stderr || "输出超过限制或操作已取消。"}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("无法解析文档结果。"));
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(spec));
  });
}

/** Read documents in the approved workspace and edit text into a downloadable copy. */
export function officeEditTools(dataDir) {
  async function sourceFor({ path, artifactId }, { safePath }) {
    if (artifactId) {
      if (!/^[a-f0-9-]{36}$/.test(artifactId)) throw new Error("无效产物 ID。");
      const metadata = JSON.parse(
        await readFile(join(dataDir, "artifacts", `${artifactId}.json`), "utf8"),
      );
      if (!["docx", "xlsx", "pptx"].includes(metadata.format))
        throw new Error("不支持该产物格式。");
      return join(dataDir, "artifacts", `${artifactId}.${metadata.format}`);
    }
    if (typeof path !== "string" || !path) throw new Error("请提供工作区路径或产物 ID。");
    return safePath(path);
  }
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "office_read",
          description:
            "Read Word paragraphs, Excel cells and cached formulas, or PowerPoint slide text. Provide a relative workspace path or artifactId equal to the id returned by office_create/office_replace. Does not run macros or calculate formulas.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, artifactId: { type: "string" } },
            anyOf: [{ required: ["path"] }, { required: ["artifactId"] }],
            additionalProperties: false,
          },
        },
      },
      requiresApproval: false,
      handler: async (args, context) =>
        run(await sourceFor(args, context), { operation: "inspect" }, null, context.signal),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "office_replace",
          description:
            "Replace text inside a Word, Excel, or PowerPoint document and create a downloadable copy, retaining other package parts. Requires approval. Text spanning separate formatting runs is reported as unmatched. Cannot change formulas or layout.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              artifactId: { type: "string" },
              title: { type: "string" },
              replacements: {
                type: "array",
                items: {
                  type: "object",
                  properties: { from: { type: "string" }, to: { type: "string" } },
                  required: ["from", "to"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "replacements"],
            anyOf: [{ required: ["path"] }, { required: ["artifactId"] }],
            additionalProperties: false,
          },
        },
      },
      requiresApproval: true,
      handler: async (args, context) => {
        const { title, replacements } = args;
        const { signal } = context;
        const source = await sourceFor(args, context),
          format = extname(source).slice(1).toLowerCase();
        const dir = join(dataDir, "artifacts");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const id = randomUUID(),
          filename = `${id}.${format}`;
        const details = await run(
          source,
          { operation: "replace", replacements },
          join(dir, filename),
          signal,
        );
        const artifact = {
          id,
          filename,
          title: String(title).slice(0, 200),
          format,
          bytes: (await stat(join(dir, filename))).size,
          createdAt: new Date().toISOString(),
          url: `/api/office/download/${filename}`,
        };
        await writeFile(join(dir, `${id}.json`), JSON.stringify(artifact), { mode: 0o600 });
        return { ...artifact, ...details };
      },
    },
  ];
}
