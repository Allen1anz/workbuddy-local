import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const output = path.resolve(process.env.WORKBUDDY_RELEASE_DIR || path.join(root, "release-artifacts", version));
const resources = path.join(output, "WorkBuddy Local Open.app/Contents/Resources");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "wb-installed-smoke-"));
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const child = spawn(path.join(resources, "runtime/node"), [path.join(resources, "app/desktop/server-launch.mjs")], {
  cwd: profile, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: "/usr/bin:/bin", HOME: profile, TMPDIR: os.tmpdir(), WORKBUDDY_DATA_DIR: path.join(profile, "data"), WORKBUDDY_LOCAL_PORT: String(port),
    WORKBUDDY_OPEN_SKILLS: "1", WORKBUDDY_DEFAULT_WORKSPACE: path.join(profile, "workspace"),
    WORKSPACE_PYTHON: path.join(resources, "runtime/python/bin/python3.12"),
    WORKBUDDY_OLLAMA_BIN: path.join(resources, "runtime/ollama/ollama"),
  },
});
let log = ""; child.stderr.on("data", bytes => { log = (log + bytes).slice(-4000); });
try {
  await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(Error("Installer backend did not start: " + log)), 30000);
    child.once("error", reject); child.once("exit", () => { clearTimeout(timer); reject(Error("Backend exited: " + log)); });
    child.stdout.on("data", bytes => { buffer += bytes; if (buffer.includes("WORKBUDDY_READY ")) { clearTimeout(timer); resolve(); } });
  });
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result;
  };
  assert.equal((await api("/skills")).length, 2);
  for (const format of ["docx", "xlsx", "pptx"]) {
    const result = await api("/office/export", "POST", { format, title: "Installer smoke", content: "Bundled Python", rows: [["Name", "Value"], ["Smoke", 1]], slides: [{ title: "Smoke", content: "Bundled Python" }] });
    assert(result.bytes > 0);
  }
  const model = await api("/local-model/start", "POST"); assert.equal(model.status, "needs-download");
  await api("/local-model/stop", "POST");
  console.log("INSTALLER SMOKE PASS: bundled Node/Python/Ollama, skills and Office formats");
} finally {
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
