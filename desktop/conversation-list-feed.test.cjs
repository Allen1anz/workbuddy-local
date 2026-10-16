"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createConversationListFeed } = require("./conversation-list-feed.cjs");

test("list subscriptions forward real partial updates and isolate each renderer lifecycle", () => {
  const main = new EventEmitter(), settings = new EventEmitter(), calls = [];
  const feed = createConversationListFeed({ publish: (...args) => calls.push(args) });
  feed.sync(main, { event: "listChanged", active: true });
  feed.sync(main, { event: "listChanged", active: true });
  feed.sync(settings, { event: "listChanged", active: true });
  feed.accept("session:upserted", { id: "test-session", title: "private text must not enter notification" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(1), ["wb:conversations:listChanged", { added: [], updated: [{ id: "test-session" }], deleted: [] }]);
  feed.sync(settings, { event: "listChanged", active: false });
  calls.length = 0;
  feed.accept("session:deleted", { sessionId: "test-session" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], main);
  assert.deepEqual(calls[0][2].deleted, ["test-session"]);
  main.emit("destroyed");
  calls.length = 0;
  feed.accept("session:upserted", { id: "test-session" });
  assert.equal(calls.length, 0);
});

test("current conversation reporting is bounded and unsupported typed streams are not acknowledged", () => {
  const sender = new EventEmitter();
  const feed = createConversationListFeed({ publish() { throw Error("current reporting must not emit list changes"); } });
  assert.deepEqual(feed.sync(sender, { event: "current", conversationIds: ["test", "test"], active: true }), { subscribed: true });
  feed.sync(sender, { event: "current", active: false });
  assert.throws(() => feed.sync(sender, { event: "current", active: true, conversationIds: Array(101).fill("test") }), /IDs/);
  assert.throws(() => feed.sync(sender, { event: "requestUpdate", active: true, conversationId: "test" }), /not available/);
  assert.throws(() => feed.sync(sender, { event: "listChanged", active: "yes" }), /Invalid/);
});
