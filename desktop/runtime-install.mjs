import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = path.join(import.meta.dirname, "runtime"),
  filename = "electron-v37.10.3-darwin-arm64.zip";
const checksums = JSON.parse(
  await fs.readFile(path.join(root, "node_modules/electron/checksums.json"), "utf8"),
);
const archivePath = process.argv[2] || path.join(root, filename);
const archive = await fs.readFile(archivePath);
const hash = createHash("sha256").update(archive).digest("hex");
if (hash !== checksums[filename]) throw Error("Electron archive checksum mismatch");
const dist = path.join(root, "node_modules/electron/dist");
await fs.mkdir(dist, { recursive: true });
const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archivePath, dist], { encoding: "utf8" });
if (result.status !== 0) throw Error(result.stderr);
await fs.writeFile(
  path.join(root, "node_modules/electron/path.txt"),
  "Electron.app/Contents/MacOS/Electron",
);
console.log("Verified Electron 37.10.3 SHA256 " + hash);
