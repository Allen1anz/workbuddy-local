import fs from "node:fs/promises";
import { spawn } from "node:child_process";
const external = new Set([
  "server/desktop-static.test.mjs", "server/renderer-capabilities.test.mjs",
  "server/resources.test.mjs", "server/expert-resources.test.mjs", "server/skill-resources.test.mjs",
  "tools/mcp-app-http.test.mjs", "tools/mcp-app-catalog.test.mjs",
]);
const files = [];
for (const directory of ["server", "tools", "desktop"]) {
  for (const name of await fs.readdir(directory)) {
    const file = `${directory}/${name}`;
    if (/\.test\.(mjs|cjs)$/.test(name) && !external.has(file)) files.push(file);
  }
}
console.log("Public tests exclude proprietary-resource and installed-original integration fixtures. See docs/PUBLISHING.md.");
const child = spawn(process.execPath, ["--test", ...files.sort()], { stdio: "inherit", env: { ...process.env, WORKBUDDY_PUBLIC_TESTS: "1" } });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
