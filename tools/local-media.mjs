import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
let busy = false;
export async function perceiveMedia(media, question, config, signal) {
  if (!media.length || !config?.enabled) return null;
  if (busy) throw Error("本地图片或语音识别正在运行，请稍后重试。");
  busy = true;
  try {
    const results = [];
    for (const block of media) {
      signal?.throwIfAborted();
      const model = block.type === "image" ? config.visionModel : config.speechModel;
      if (!path.isAbsolute(model || "") || !path.isAbsolute(config.python || "")) throw Error("本地媒体模型路径未配置。");
      await fs.access(path.join(model, "config.json"));
      const text = await new Promise((resolve, reject) => {
        const child = spawn(config.python, [path.join(import.meta.dirname, "local-media-worker.py")], { stdio: ["pipe", "pipe", "pipe"] });
        let output = "", settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(Error("本地媒体识别超过180秒，已释放进程。")); }, 180000);
        const abort = () => { child.kill("SIGKILL"); finish(Error("本地媒体识别已取消。")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", data => { output += data; if (output.length > 100000) { child.kill("SIGKILL"); finish(Error("媒体识别结果过长。")); } });
        child.stderr.resume();
        child.on("error", error => finish(error));
        child.stdin.on("error", () => {});
        child.on("close", code => {
          if (code !== 0) return finish(Error("本地媒体识别失败，请检查模型与运行环境。"));
          try { const value = JSON.parse(output).text; if (typeof value !== "string" || !value.trim()) throw Error(); finish(null, value); }
          catch { finish(Error("本地媒体识别未返回有效内容。")); }
        });
        child.stdin.end(JSON.stringify({ ...block, format: block.mimeType.split("/")[1].replace("x-wav", "wav").replace("mpeg", "mp3"), model, question }));
      });
      results.push((block.type === "image" ? "[本地视觉模型观察，可能存在识别误差]" : "[本地语音转写，可能存在识别误差]") + "\n" + text);
    }
    return results.join("\n\n");
  } finally { busy = false; }
}
