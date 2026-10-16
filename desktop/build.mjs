import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, "desktop/runtime/node_modules/electron/dist");
const target = path.join(root, "dist/WorkBuddy Local.app");
const contents = path.join(target, "Contents"),
  resources = path.join(contents, "Resources");
await fs.access(path.join(runtime, "Electron.app"));
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.cp(path.join(runtime, "Electron.app"), target, {
  recursive: true,
  verbatimSymlinks: true,
});
const appRoot = path.join(resources, "app");
await fs.mkdir(appRoot, { recursive: true });
for (const entry of [
  "workspace.mjs",
  "server",
  "tools",
  "public",
  "node_modules",
])
  await fs.cp(path.join(root, entry), path.join(appRoot, entry), {
    recursive: true,
    verbatimSymlinks: true,
  });
try {
  await fs.cp(path.join(root, "desktop-ui"), path.join(appRoot, "desktop-ui"), {
    recursive: true,
    verbatimSymlinks: true,
  });
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await fs.mkdir(path.join(appRoot, "desktop"), { recursive: true });
for (const entry of [
  "main.cjs",
  "settings-window.cjs",
  "conversation-list-feed.cjs",
  "conversation-sdk.cjs",
  "media-input.cjs",
  "mcp-webview.cjs",
  "mcp-app-watch.cjs",
  "local-model.cjs",
  "model-connectivity.cjs",
  "qa-rpc-trace.cjs",
  "preload.cjs",
  "server-launch.mjs",
  "native-dispatch.cjs",
  "renderer-bridge.cjs",
  "preload.bundle.cjs",
  "dispatcher.cjs",
  "skill-metadata.cjs",
  "bundled-plugins.cjs",
  "custom-experts.cjs",
  "expert-catalog.cjs",
  "expert-zip.cjs",
  "expert-switch.cjs",
  "automation-watch.cjs",
  "skill-package-watch.cjs",
])
  await fs.copyFile(path.join(root, "desktop", entry), path.join(appRoot, "desktop", entry));
await fs.writeFile(
  path.join(appRoot, "package.json"),
  JSON.stringify({ name: "workbuddy-local-desktop", version: "0.1.0", main: "desktop/main.cjs" }),
);
await fs.mkdir(path.join(resources, "runtime"), { recursive: true });
await fs.copyFile(
  process.env.WORKBUDDY_NODE || "/usr/local/bin/node",
  path.join(resources, "runtime/node"),
);
await fs.chmod(path.join(resources, "runtime/node"), 0o755);
for (const license of ["LICENSE", "LICENSES.chromium.html"]) {
  try {
    await fs.copyFile(path.join(runtime, license), path.join(resources, license));
  } catch {}
}
// Electron distributed top-level LICENSE is the MIT license for the runtime.
await fs.copyFile(
  path.join(root, "desktop/runtime/node_modules/electron/LICENSE"),
  path.join(resources, "Electron-LICENSE"),
);
await fs.copyFile(path.join(root, "desktop/Node-LICENSE"), path.join(resources, "Node-LICENSE"));
await fs.rename(
  path.join(contents, "MacOS/Electron"),
  path.join(contents, "MacOS/WorkBuddy Local"),
);
// Keep the Electron icon; proprietary product artwork is not distributed.
const plist = path.join(contents, "Info.plist");
for (const [key, value] of Object.entries({
  CFBundleExecutable: "WorkBuddy Local",
  CFBundleIdentifier: "local.workbuddy.desktop",
  CFBundleName: "WorkBuddy Local",
  CFBundleDisplayName: "WorkBuddy Local",
  CFBundleShortVersionString: "0.1.0",
  CFBundleVersion: "1",
})) {
  const result = spawnSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw Error(result.stderr);
}
// Ad-hoc sign this new local bundle; no original application is modified.
const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", target], {
  encoding: "utf8",
});
if (sign.status !== 0) throw Error(sign.stderr);
console.log(target);
