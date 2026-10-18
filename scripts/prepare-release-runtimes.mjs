import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(root, ".release-cache");
const manifest = JSON.parse(await fs.readFile(path.join(root, "desktop/runtime-manifest.json"), "utf8"));
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("Release target requires macOS arm64");
await fs.mkdir(cache, { recursive: true });
async function download(url, destination, expected) {
  let valid = false;
  try { valid = createHash("sha256").update(await fs.readFile(destination)).digest("hex") === expected; } catch {}
  if (!valid) {
    console.log("Downloading " + path.basename(destination));
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw Error("Download failed HTTP " + response.status + ": " + url);
    await pipeline(response.body, createWriteStream(destination));
    const digest = createHash("sha256").update(await fs.readFile(destination)).digest("hex");
    if (digest !== expected) throw Error("SHA256 mismatch for " + path.basename(destination));
  }
  console.log("SHA256 verified: " + path.basename(destination));
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw Error(command + " failed");
}
for (const name of ["electron", "ollama", "python"]) {
  const spec = manifest[name], archive = path.join(cache, name + (name === "electron" ? ".zip" : ".tgz"));
  await download(spec.url, archive, spec.sha256);
  if (name === "electron") {
    await fs.mkdir(path.join(cache, "electron"), { recursive: true });
    run("/usr/bin/ditto", ["-x", "-k", archive, path.join(cache, "electron")]);
  } else if (name === "ollama") {
    await fs.mkdir(path.join(cache, "ollama"), { recursive: true });
    run("/usr/bin/tar", ["-xzf", archive, "-C", path.join(cache, "ollama")]);
  } else run("/usr/bin/tar", ["-xzf", archive, "-C", cache]);
}
async function notice(url, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error("License download failed: " + url);
  await fs.writeFile(filename, await response.text());
}
await notice(`https://raw.githubusercontent.com/ollama/ollama/v${manifest.ollama.version}/LICENSE`, path.join(cache, "OLLAMA-LICENSE"));
const licenses = path.join(cache, "python/share/runtime-licenses"); await fs.mkdir(licenses, { recursive: true });
for (const name of ["cpython", "bzip2", "expat", "libedit", "libffi", "liblzma", "mpdecimal", "ncurses", "openssl-3", "sqlite", "tcl", "tix", "zlib"])
  await notice(`https://raw.githubusercontent.com/astral-sh/python-build-standalone/${manifest.python.version.split("+")[1]}/LICENSE.${name}.txt`, path.join(licenses, `LICENSE.${name}.txt`));
console.log("Pinned release runtimes and notices are ready.");
