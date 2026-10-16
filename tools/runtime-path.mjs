import path from "node:path";

/** Select the app's Node for future workspace commands without changing system settings. */
export function workspaceRuntimePath(policy, inheritedPath = process.env.PATH || "", nodeExecutable = process.execPath) {
  if (policy?.enabled === false || policy?.tools?.node === false) return inheritedPath;
  const runtimeDir = path.dirname(nodeExecutable);
  return [runtimeDir, ...inheritedPath.split(path.delimiter).filter(p => p && p !== runtimeDir)].join(path.delimiter);
}
