"use strict";
const { createHash } = require("node:crypto");
function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function conversationInfo(session) {
  const states = { running: "working", streaming: "working", planning: "planning", working: "working", pending: "pending", waiting_permission: "pending", waiting_question: "pending", failed: "failed", error: "error", cancelled: "terminated", terminated: "terminated" };
  const cwd = session.workspace || session.cwd;
  return { id: session.id, title: session.title || session.name || session.id,
    state: states[session.status] || "idle", lifecycle: session.archived ? "archived" : ["running", "pending"].includes(session.status) ? "active" : "completed",
    space: { type: "local", cwd, name: cwd || "local" }, transport: "local", origin: "desktop", kind: "task", conversationOrigin: "local",
    createdAt: timestamp(session.createdAt), updatedAt: timestamp(session.updatedAt),
    lastActivityAt: timestamp(session.lastActivityAt) ?? timestamp(session.updatedAt) ?? timestamp(session.createdAt) ?? 0,
    isPinned: session.pinned === true, unread: session.unread === true };
}
function conversationSnapshot(session) {
  const model = session.config?.model || session.model || "";
  return { info: conversationInfo(session), configManager: {
    mode: session.config?.mode || session.mode || "craft",
    model: model && !model.startsWith("custom-local:") ? "custom-local:" + model : model,
    connectors: session.config?.connectors || [], expertId: session.config?.expertId || session.expertId || "",
    permissionMode: session.config?.permissionMode || "default", useSandboxCLI: false,
  } };
}
function textRequests(session, messages, events = []) {
  if (events.some(event => ["tool", "tool_result"].includes(event.event)))
    throw Error("新版工具历史尚未适配，无法完整展示此会话");
  const requests = [];
  const idFor = id => /^[a-f0-9-]{36}$/i.test(id || "") ? id.replaceAll("-", "").toLowerCase() : createHash("sha256").update(String(id)).digest("hex").slice(0, 32);
  for (const message of messages) {
    if (!["user", "assistant"].includes(message.role)) continue;
    if (typeof message.content !== "string") throw Error("Unsupported historical message content");
    let request = requests.at(-1);
    if (message.role === "user" || !request) {
      const id = idFor(message.id);
      request = { id, identity: { requestId: id }, timestamp: timestamp(message.createdAt),
        userMessage: { type: "text", content: [], state: "completed" }, state: "completed" };
      requests.push(request);
    }
    if (message.role === "user") request.userMessage.content.push({ type: "text", text: message.content });
    else {
      request.assistantMessage ||= { type: "text", content: [], state: "completed", contentIdentity: "message" };
      request.assistantMessage.content.push({ type: "text", text: message.content });
      request.finishTimestamp = timestamp(message.createdAt);
    }
  }
  const last = requests.at(-1);
  if (last) {
    last.state = { running: "streaming", pending: "pending", failed: "error", error: "error", cancelled: "cancelled" }[session.status] || (last.assistantMessage ? "completed" : "cancelled");
    if (last.assistantMessage && last.state === "streaming") last.assistantMessage.state = "streaming";
  }
  return requests;
}
function requestEntries(requests, options = {}) {
  let end = requests.length;
  if (options.beforeRequestId) {
    end = requests.findIndex(request => request.id === options.beforeRequestId);
    if (end < 0) throw Error("Unknown history request cursor");
  }
  const budget = Math.min(5 * 1024 * 1024, Math.max(1, Number(options.byteLength) || 5 * 1024 * 1024));
  let start = end, bytes = 0;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(requests[start - 1]));
    if (start < end && bytes + size > budget) break;
    start--; bytes += size;
  }
  const selected = requests.slice(start, end);
  return { requests: selected, entries: selected.flatMap(request => [
    { kind: "request-message", requestId: request.id, role: "user" },
    ...(request.assistantMessage ? [{ kind: "request-message", requestId: request.id, role: "assistant" }] : []),
  ]), totalRequests: requests.length, hasOlder: start > 0, historyReady: true, historyKnownEmpty: requests.length === 0 };
}
module.exports = { conversationInfo, conversationSnapshot, textRequests, requestEntries };
