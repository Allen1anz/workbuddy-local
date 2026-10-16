const channels = new Set([
  "session:sendMessage",
  "session:prompt",
  "session:create",
  "session:updateConfig",
  "expert:summonExpert",
]);
const publicFields = new Set([
  "id",
  "sessionId",
  "agentId",
  "expertId",
  "expectedExpertId",
  "skillId",
  "skillIds",
  "skillName",
  "skillNames",
  "mode",
  "model",
  "modelId",
  "cwd",
  "resumeCwd",
  "agentType",
  "name",
  "title",
]);
const sensitive = /key|token|secret|auth|cookie|credential|password|headers|baseurl/i;
function clean(value, depth = 0) {
  if (depth > 5) return "<depth-limit>";
  if (typeof value === "string")
    return value
      .slice(0, 6000)
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted>")
      .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"'<>]+/gi, "$1<redacted>");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => clean(v, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitive.test(key) || key === "config" || key === "data" || key === "bytes") continue;
    result[key] = clean(item, depth + 1);
  }
  return result;
}
function capture(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value !== "object" || value === null) return clean(value);
  if (Array.isArray(value)) return value.slice(0, 15).map((v) => capture(v, depth + 1));
  if (["text", "resource_link", "resource", "image", "audio"].includes(value.type))
    return clean(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (publicFields.has(key)) result[key] = clean(item);
    else if (["prompt", "blocks", "content", "message"].includes(key)) result[key] = clean(item);
    else if (["meta", "_meta"].includes(key)) result[key] = clean(item);
    else if (["config", "options", "params", "patch", "context"].includes(key)) {
      const publicValue = capture(item, depth + 1);
      if (publicValue && Object.keys(publicValue).length) result[key + "Bindings"] = publicValue;
    }
  }
  return result;
}
function createQaRpcTrace({ enabled, writeLog }) {
  const counts = new Map();
  return (channel, args, context) => {
    if (!enabled || !channels.has(channel)) return;
    const count = counts.get(channel) || 0;
    counts.set(channel, count + 1);
    if (count >= 100) return;
    const record = {
      channel,
      args: capture(args),
      ...(context ? { context: capture(context) } : {}),
    };
    writeLog("QA RPC " + JSON.stringify(record).slice(0, 16000));
  };
}
module.exports = { createQaRpcTrace };
