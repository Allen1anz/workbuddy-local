import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("This release target is macOS arm64.");
const electron = path.resolve(process.env.WORKBUDDY_ELECTRON_DIST || path.join(root, "desktop/runtime/node_modules/electron/dist"));
const ollama = path.join(root, ".release-cache/ollama");
const python = path.join(root, ".release-cache/python");
for (const filename of [path.join(electron, "Electron.app/Contents/MacOS/Electron"), path.join(ollama, "ollama"), path.join(python, "bin/python3.12")]) await fs.access(filename);
const output = path.resolve(process.env.WORKBUDDY_RELEASE_DIR || path.join(root, "release-artifacts", version));
await fs.mkdir(output, { recursive: true });
const app = path.join(output, "WorkBuddy Local Open.app");
try { await fs.access(app); throw Error("Output already exists; choose a new version or explicitly clear the build output."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.cp(path.join(electron, "Electron.app"), app, { recursive: true, verbatimSymlinks: true });
const resources = path.join(app, "Contents/Resources"), appRoot = path.join(resources, "app");
await fs.mkdir(appRoot, { recursive: true });
for (const name of ["workspace.mjs", "server", "tools", "public", "desktop", "open-skills", "node_modules", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await fs.cp(path.join(root, name), path.join(appRoot, name), { recursive: true, verbatimSymlinks: true,
    filter: source => !source.includes(path.sep + "runtime" + path.sep) && path.basename(source) !== "runtime" && !/\.test\.(mjs|cjs)$/.test(source) && !source.includes("__pycache__"),
  });
}
await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ name: "workbuddy-local-open", version, main: "desktop/public-main.cjs" }));
await fs.mkdir(path.join(resources, "runtime"), { recursive: true });
await fs.copyFile(process.env.WORKBUDDY_NODE || process.execPath, path.join(resources, "runtime/node"));
await fs.chmod(path.join(resources, "runtime/node"), 0o755);
await fs.cp(ollama, path.join(resources, "runtime/ollama"), { recursive: true, verbatimSymlinks: true });
await fs.copyFile(path.join(root, ".release-cache/OLLAMA-LICENSE"), path.join(resources, "runtime/ollama/LICENSE"));
await fs.cp(python, path.join(resources, "runtime/python"), { recursive: true, verbatimSymlinks: true });
for (const name of ["LICENSE", "LICENSES.chromium.html"]) await fs.copyFile(path.join(electron, name), path.join(resources, name));
await fs.copyFile(path.join(root, "desktop/Node-LICENSE"), path.join(resources, "Node-LICENSE"));
await fs.rename(path.join(app, "Contents/MacOS/Electron"), path.join(app, "Contents/MacOS/WorkBuddy Local Open"));
const plist = path.join(app, "Contents/Info.plist");
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 10_000_000 });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
for (const [key, value] of Object.entries({ CFBundleExecutable: "WorkBuddy Local Open", CFBundleIdentifier: "io.github.allen1anz.workbuddy-local-open", CFBundleName: "WorkBuddy Local Open", CFBundleDisplayName: "工作伙伴开源版", CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: "14.0" }))
  run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const zip = path.join(output, `WorkBuddy-Local-Open-${version}-macOS-arm64.zip`);
run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
const staging = path.join(output, "dmg-root"); await fs.mkdir(staging);
await fs.symlink("/Applications", path.join(staging, "Applications"));
const dmg = path.join(output, `WorkBuddy-Local-Open-${version}-macOS-arm64.dmg`);
await fs.cp(app, path.join(staging, "WorkBuddy Local Open.app"), { recursive: true, verbatimSymlinks: true });
run("/usr/bin/hdiutil", ["create", "-volname", "WorkBuddy Local Open", "-srcfolder", staging, "-ov", "-format", "UDZO", dmg]);
const checksums = [];
for (const file of [zip, dmg]) checksums.push(createHash("sha256").update(await fs.readFile(file)).digest("hex") + "  " + path.basename(file));
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
console.log(JSON.stringify({ version, app, zip, dmg, notarized: false }, null, 2));
