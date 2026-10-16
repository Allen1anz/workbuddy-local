"use strict";
const formats = new Map([
  ["image/png", "png"], ["image/jpeg", "jpeg"], ["image/webp", "webp"],
  ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["audio/mpeg", "mp3"],
]);
// Validate again at the HTTP boundary; renderer input is untrusted.
function mediaParts(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length > 8) throw Error("每条消息最多8个图片或音频附件。");
  let total = 0;
  return blocks.map((block) => {
    if (!block || !["image", "audio"].includes(block.type)) throw Error("未知媒体附件类型。");
    const format = formats.get(block.mimeType);
    if (!format || !block.mimeType.startsWith(block.type + "/")) throw Error("附件格式暂不支持；图片使用PNG/JPEG/WebP，音频使用WAV/MP3。");
    if (typeof block.data !== "string" || !block.data.length || block.data.length > 8_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) throw Error("附件数据不是有效的Base64。");
    const bytes = Buffer.from(block.data, "base64");
    total += bytes.length;
    if (total > 5_000_000) throw Error("每条消息媒体附件合计不能超过5MB。");
    const valid = format === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : format === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : format === "webp" ? bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP"
      : format === "wav" ? bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WAVE"
      : bytes.toString("ascii",0,3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224);
    if (!valid) throw Error("附件内容与声明格式不符。");
    return block.type === "image"
      ? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
      : { type: "input_audio", input_audio: { data: block.data, format } };
  });
}
module.exports = { mediaParts };
