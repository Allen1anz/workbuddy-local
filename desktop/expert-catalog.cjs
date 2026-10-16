const fs = require("node:fs/promises");
const path = require("node:path");
const base = "https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";
let cached;
function localAsset(value, origin) {
  return typeof value === "string" && value.startsWith(base + "/")
    ? origin + "/expert-catalog-assets" + value.slice(base.length) : value;
}
function asset(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("..")) return value;
  return base + value;
}
function localExpert(expert, origin) {
  return { ...expert, avatar: localAsset(expert.avatar, origin),
    ...(expert.expertType === "team" ? { runtimeAvailable: false } : {}),
    ...(expert.members ? { members: expert.members.map(member => ({ ...member,
      avatar: localAsset(asset(member.avatar), origin),
    })).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead") || String(a.id).localeCompare(String(b.id))) } : {}),
  };
}
async function catalog(origin) {
  if (!cached) cached = Promise.all(["experts.json", "scenes.json"].map(name =>
    fs.readFile(path.join(__dirname, "../desktop-resources/expert-catalog", name), "utf8").then(JSON.parse)
  )).then(([manifest, featured]) => ({
    categories: manifest.categories,
    experts: manifest.experts.map(expert => ({ ...expert, name: expert.displayName?.zh || expert.id,
      avatar: asset(expert.avatar), source: "public-expert-catalog", isCustom: false,
      ...(expert.expertType === "team" ? { runtimeAvailable: false } : {}) })),
    scenes: featured.scenes.map(scene => ({ ...scene,
      ...Object.fromEntries(["image", "darkImage", "headerImage", "darkHeaderImage"].map(key => [key, asset(scene[key])])),
      expertAvatars: Object.fromEntries(Object.entries(scene.expertAvatars || {}).map(([key,value]) => [key,asset(value)])),
    })),
  })).catch(error => { cached = null; throw error; });
  const data = await cached;
  if (!origin) return data;
  const local = value => localAsset(value, origin);
  return { ...data,
    experts: data.experts.map(expert => localExpert(expert, origin)),
    scenes: data.scenes.map(scene => ({ ...scene,
      ...Object.fromEntries(["image", "darkImage", "headerImage", "darkHeaderImage"].map(key => [key, local(scene[key])])),
      expertAvatars: Object.fromEntries(Object.entries(scene.expertAvatars).map(([key,value]) => [key,local(value)])),
    })),
  };
}
async function instructions(expert, request = fetch) {
  const file = typeof expert.promptFile === "string" ? expert.promptFile : expert.promptFile?.zh;
  if (!file?.startsWith("/") || file.startsWith("//") || file.includes("..")) throw Error("专家指令地址无效");
  const response = await request(base + file, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw Error("专家指令暂时无法获取，请稍后重试");
  const content = await response.text();
  if (!content.trim() || Buffer.byteLength(content) > 1000000) throw Error("专家指令内容无效");
  return content;
}
module.exports = { catalog, instructions, localAsset, localExpert };
