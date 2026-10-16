"use strict";

/** Renderer-scoped SDK list subscriptions, backed by the existing local session events. */
function createConversationListFeed({ publish }) {
  const subscribers = new Set(), current = new Map(), tracked = new WeakSet();
  function sync(sender, request) {
    if (!sender || typeof request?.active !== "boolean") throw Error("Invalid conversation subscription");
    if (request.event === "listChanged") {
      if (request.active) subscribers.add(sender);
      else subscribers.delete(sender);
    } else if (request.event === "current") {
      const ids = request.conversationIds ?? (request.conversationId ? [request.conversationId] : []);
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !id || id.length > 512))
        throw Error("Invalid current conversation IDs");
      current.set(sender, request.active ? [...new Set(ids)] : []);
    } else {
      throw Error("This conversation event subscription is not available locally: " + request.event);
    }
    if (!tracked.has(sender)) {
      tracked.add(sender);
      sender.once("destroyed", () => { subscribers.delete(sender); current.delete(sender); });
    }
    return { subscribed: request.active };
  }
  function accept(channel, result) {
    if (!["session:upserted", "session:deleted"].includes(channel)) return;
    const id = result?.id ?? result?.sessionId;
    if (typeof id !== "string" || !id) return;
    // The SDK itself uses {id} for partial list updates (e.g. markRead).
    const event = channel === "session:deleted"
      ? { added: [], updated: [], deleted: [id] }
      : { added: [], updated: [{ id }], deleted: [] };
    for (const sender of subscribers) publish(sender, "wb:conversations:listChanged", event);
  }
  return { sync, accept };
}
module.exports = { createConversationListFeed };
