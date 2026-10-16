import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { workspaceRuntimePath } from "./runtime-path.mjs";

test("enabled packaged Node policy selects the actual runtime without mutating inherited PATH", () => {
  const inherited = "/usr/bin:/bin";
  const selected = workspaceRuntimePath({ enabled: true, tools: { node: true } }, inherited);
  const result = spawnSync("node", ["-p", "process.execPath"], { env: { PATH: selected }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
  assert.equal(workspaceRuntimePath({ enabled: false }, inherited), inherited);
  assert.equal(workspaceRuntimePath({ enabled: true, tools: { node: false } }, inherited), inherited);
  assert.equal(inherited, "/usr/bin:/bin");
});
