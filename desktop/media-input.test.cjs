const test = require("node:test");
const assert = require("node:assert/strict");
const { mediaParts } = require("./media-input.cjs");
test("media rejects spoofed types, URLs, oversized payloads and malformed base64", () => {
  for (const data of ["https://example.com/private.png", "!!!!", Buffer.from("not an image").toString("base64")])
    assert.throws(() => mediaParts([{type:"image",mimeType:"image/png",data}]));
  assert.throws(() => mediaParts([{type:"audio",mimeType:"image/png",data:"AAAA"}]));
  assert.throws(() => mediaParts(Array(9).fill({})));
  assert.throws(() => mediaParts([{type:"image",mimeType:"image/png",data:"A".repeat(8_000_004)}]));
  assert.deepEqual(mediaParts(), []);
});
