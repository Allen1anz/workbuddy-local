"use strict";
const fs = require("node:fs/promises"),
  path = require("node:path");
const { inflateRawSync, crc32 } = require("node:zlib");
async function readPackageZip(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw Error("Expert ZIP exceeds 50 MiB");
  const bytes = await fs.readFile(filename);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw Error("Invalid ZIP directory");
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw Error("Split ZIP is unsupported");
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12);
  let at = bytes.readUInt32LE(end + 16),
    total = 0;
  if (count > 2000 || count === 65535 || at + size > end)
    throw Error("ZIP directory limit exceeded");
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw Error("Invalid ZIP entry");
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      crc = bytes.readUInt32LE(at + 16),
      compressed = bytes.readUInt32LE(at + 20),
      length = bytes.readUInt32LE(at + 24),
      n = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42);
    if (at + 46 + n + extra + comment > end) throw Error("Truncated ZIP entry");
    const name = bytes.subarray(at + 46, at + 46 + n).toString("utf8");
    const unixType = (bytes.readUInt32LE(at + 38) >>> 16) & 0xf000;
    if (flags & 1 || ![0, 8].includes(method))
      throw Error("Encrypted or unsupported ZIP compression");
    if (unixType && ![0x8000, 0x4000].includes(unixType))
      throw Error("ZIP links and special files are forbidden");
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").some((x) => x === ".." || x === ".")
    )
      throw Error("ZIP path escapes package");
    at += 46 + n + extra + comment;
    if (name.endsWith("/")) continue;
    if (files.has(name)) throw Error("Duplicate ZIP path");
    total += length;
    if (total > 50 * 1024 * 1024 || length > 20 * 1024 * 1024)
      throw Error("Expanded ZIP limit exceeded");
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      throw Error("Invalid ZIP local header");
    const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (offset + compressed > bytes.length) throw Error("Truncated ZIP data");
    const raw = bytes.subarray(offset, offset + compressed),
      content =
        method === 0
          ? Buffer.from(raw)
          : inflateRawSync(raw, { maxOutputLength: Math.max(1, length) });
    if (content.length !== length || crc32(content) !== crc) throw Error("ZIP integrity mismatch");
    files.set(name, content);
  }
  return files;
}
async function readExpertZip(filename) {
  const files = await readPackageZip(filename);
  const manifests = [...files.keys()].filter((name) =>
    /(?:^|\/)(?:\.codebuddy-plugin|\.workbuddy-plugin)\/plugin\.json$/.test(name),
  );
  const roots = new Set(
    manifests.map((name) =>
      name.slice(
        0,
        -(
          name.endsWith(".workbuddy-plugin/plugin.json")
            ? ".workbuddy-plugin/plugin.json"
            : ".codebuddy-plugin/plugin.json"
        ).length,
      ),
    ),
  );
  if (roots.size !== 1) throw Error("ZIP must contain exactly one expert package");
  const prefix = [...roots][0];
  const result = new Map();
  for (const [name, content] of files) {
    if (!name.startsWith(prefix)) throw Error("ZIP contains files outside expert package");
    result.set(name.slice(prefix.length), content);
  }
  return result;
}
function createExpertZip(files) {
  if (files.size > 2000) throw Error("ZIP entry limit exceeded");
  const local = [],
    central = [];
  let offset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename, "utf8");
    if (name.length > 65535 || offset + content.length > 50 * 1024 * 1024)
      throw Error("Export ZIP limit exceeded");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc32(content), 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(content.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, content);
    central.push(entry, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function normalizeLocalizedManifestItems(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const zh = Array.isArray(value.zh) ? value.zh : [],
    en = Array.isArray(value.en) ? value.en : [];
  return Array.from({ length: Math.max(zh.length, en.length) }, (_, index) => ({
    ...(zh[index] === undefined ? {} : { zh: zh[index] }),
    ...(en[index] === undefined ? {} : { en: en[index] }),
  }));
}
function normalizeExpertManifest(manifest) {
  const result = { ...manifest };
  for (const key of ["tags", "quickPrompts", "triggerPrompts"])
    if (result[key] !== undefined) result[key] = normalizeLocalizedManifestItems(result[key]);
  for (const key of ["members", "connectorIds", "bin", "references"])
    if (result[key] !== undefined && !Array.isArray(result[key])) result[key] = [];
  return result;
}
function expertManifestPath(files) {
  return files.has(".codebuddy-plugin/plugin.json")
    ? ".codebuddy-plugin/plugin.json"
    : ".workbuddy-plugin/plugin.json";
}
module.exports = {
  normalizeExpertManifest,
  normalizeLocalizedManifestItems,
  readPackageZip,
  readExpertZip,
  createExpertZip,
  expertManifestPath,
};
