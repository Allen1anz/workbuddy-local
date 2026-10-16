import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  target = path.join(root, "dist/WorkBuddy Local.app"),
  dest = path.join(target, "Contents/Resources/app/desktop");
await fs.access(path.join(dest, "main.cjs"));
await fs.copyFile(path.join(root, "desktop-resources/model-settings-5.8.3.json"),
  path.join(target, "Contents/Resources/app/desktop-resources/model-settings-5.8.3.json"));
await fs.cp(path.join(root, "desktop-ui/expert-catalog-assets"),
  path.join(target, "Contents/Resources/app/desktop-ui/expert-catalog-assets"), { recursive: true });
await fs.cp(path.join(root, "desktop-resources/expert-catalog"),
  path.join(target, "Contents/Resources/app/desktop-resources/expert-catalog"), { recursive: true });
await fs.cp(path.join(root, "desktop-resources/product-scenes"),
  path.join(target, "Contents/Resources/app/desktop-resources/product-scenes"), { recursive: true });
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
  "native-dispatch.cjs",
  "preload.bundle.cjs",
  "renderer-bridge.cjs",
  "dispatcher.cjs",
  "skill-metadata.cjs",
  "skill-package-watch.cjs",
  "bundled-plugins.cjs",
  "custom-experts.cjs",
  "expert-catalog.cjs",
  "expert-zip.cjs",
  "expert-switch.cjs",
  "automation-watch.cjs",
  "server-launch.mjs",
])
  await fs.copyFile(path.join(root, "desktop", entry), path.join(dest, entry));
await fs.copyFile(
  path.join(root, "server/app.mjs"),
  path.join(target, "Contents/Resources/app/server/app.mjs"),
);
await fs.copyFile(path.join(root, "server/renderer-capabilities.mjs"),
  path.join(target, "Contents/Resources/app/server/renderer-capabilities.mjs"));
await fs.copyFile(
  path.join(root, "workspace.mjs"),
  path.join(target, "Contents/Resources/app/workspace.mjs"),
);
for (const helper of [
  "runtime-path.mjs",
  "local-media.mjs",
  "dsh-runtime.mjs",
  "dsh-product-sdk.mjs",
  "dsh-product-tools.mjs",
  "local-media-worker.py",
  "calendar-schedule.mjs",
  "mcp.mjs",
  "mcp-sse.mjs",
  "mcp-config.mjs",
  "mcp-store.mjs",
  "mcp-pool.mjs",
  "mcp-app-catalog.mjs",
  "mcp-app-resource.mjs",
  "mcp-app-instances.mjs",
  "mcp-app-http.mjs",
  "mcp-app-sandbox.html",
  "mcp-app-preload.cjs",
  "mcp-list.mjs",
])
  await fs.copyFile(
    path.join(root, "tools", helper),
    path.join(target, "Contents/Resources/app/tools", helper),
  );
const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", target], {
  encoding: "utf8",
});
if (sign.status !== 0) throw Error(sign.stderr);
const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], {
  encoding: "utf8",
});
if (verify.status !== 0) throw Error(verify.stderr);
console.log("Updated and verified " + target);
