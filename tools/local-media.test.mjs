import test from "node:test";
import assert from "node:assert/strict";
import { perceiveMedia } from "./local-media.mjs";
test("disabled local perception leaves native media routing available", async () => {
  assert.equal(await perceiveMedia([], "test", {enabled:true}), null);
  assert.equal(await perceiveMedia([{}], "test", undefined), null);
});
test("invalid local paths and cancellation fail without starting a model", async () => {
  await assert.rejects(perceiveMedia([{type:"image"}], "test", {enabled:true,python:"relative",visionModel:"relative"}), /路径未配置/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(perceiveMedia([{type:"image"}], "test", {enabled:true}, controller.signal), /abort/i);
});
