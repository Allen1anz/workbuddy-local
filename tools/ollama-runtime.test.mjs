import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createOllamaRuntime } from "./ollama-runtime.mjs";
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
test("private Ollama launch scopes storage, downloads explicitly, rejects incomplete pulls and cancels", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-ollama-"));
  let options, controller, requestCount = 0, mode = "incomplete";
  const runtime = createOllamaRuntime({ dataDir, binary: process.execPath,
    spawnProcess(binary, args, opts) { options = opts; const proc = new EventEmitter(); proc.stderr = new EventEmitter(); return proc; },
    async request(url, opts = {}) {
      requestCount++;
      if (url.endsWith("/api/tags")) return Response.json({ models: [] });
      assert.equal(JSON.parse(opts.body).model, "qwen3:1.7b");
      if (mode === "incomplete") return new Response('{"status":"downloading"}\n');
      if (mode === "success") return new Response('{"total":100,"completed":100}\n{"status":"success"}\n');
      controller = opts.signal;
      return new Response(new ReadableStream({ start(stream) { controller.addEventListener("abort", () => stream.error(new Error("cancelled"))); } }));
    },
  });
  assert.equal(requestCount, 0);
  await runtime.download();
  for (let i = 0; i < 100 && runtime.snapshot().status === "downloading"; i++) await delay();
  assert.equal(runtime.snapshot().status, "error");
  assert.match(runtime.snapshot().error, /未返回完成/);
  assert.equal(options.env.OLLAMA_KEEP_ALIVE, "0");
  assert.equal(options.env.OLLAMA_NUM_PARALLEL, "1");
  assert.equal(options.env.HOME, path.join(dataDir, "local-model"));
  assert.equal(options.env.OLLAMA_NO_CLOUD, "1");
  mode = "success"; await runtime.download();
  for (let i = 0; i < 100 && runtime.snapshot().status === "downloading"; i++) await delay();
  assert.equal(runtime.snapshot().status, "ready");
  runtime.stop();
  mode = "cancel"; await runtime.download(); await delay(); runtime.stop(); await delay();
  assert.equal(controller.aborted, true); assert.equal(runtime.snapshot().status, "stopped");
  runtime.close(); await assert.rejects(runtime.start(), /退出/);
});
