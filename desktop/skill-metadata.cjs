"use strict";
function skillTextMetadata(content = "") {
  const header = String(content).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) return {};
  const lines = header.split(/\r?\n/), result = {};
  for (const key of ["name", "description"]) {
    const index = lines.findIndex((line) => line.startsWith(key + ":"));
    if (index < 0) continue;
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[|>][-+]?$/.test(value)) {
      const block = [];
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        if (lines[cursor].trim() && !/^[ \t]/.test(lines[cursor])) break;
        block.push(lines[cursor].replace(/^[ \t]+/, ""));
      }
      value = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      value = value.replace(/[ \t]+#.*$/, "").trim();
    }
    if (value) result[key] = value;
  }
  return result;
}
function skillFlags(content = "") {
  const header = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  const flags = {};
  for (const [key, field] of [
    ["disable-model-invocation", "disableModelInvocation"],
    ["user-invocable", "userInvocable"],
  ]) {
    const value = header.match(
      new RegExp("^" + key + ":[ \\t]*(true|false)(?:[ \\t]+#.*)?[ \\t]*$", "mi"),
    )?.[1];
    if (value !== undefined) flags[field] = value.toLowerCase() === "true";
  }
  return flags;
}
function setModelInvocationDisabled(content, disable) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const flag = "disable-model-invocation: " + (disable ? "true" : "false");
  if (!header) return ["---", flag, "---", content].join(newline);
  const lines = header[1].split(/\r?\n/).filter((line) => !/^disable-model-invocation:/.test(line));
  lines.push(flag);
  return ["---", ...lines, "---", ""].join(newline) + content.slice(header[0].length);
}
function skillInvocationChanges(previousContent, nextContent) {
  const previous = skillFlags(previousContent), next = skillFlags(nextContent), changes = {};
  if (previous.disableModelInvocation !== next.disableModelInvocation) {
    changes.disableModelInvocation = next.disableModelInvocation ?? false;
    changes.enabled = !changes.disableModelInvocation;
  }
  if (previous.userInvocable !== next.userInvocable) changes.userInvocable = next.userInvocable ?? true;
  return changes;
}
module.exports = { skillFlags, skillTextMetadata, skillInvocationChanges, setModelInvocationDisabled };
