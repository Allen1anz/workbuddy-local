const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { scanCustomExperts } = require("../custom-experts.cjs");
test("scan independent expert packages, detect edits and reject escaping agent links", async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-custom-experts-"));
  const root = path.join(config, "plugins/marketplaces/my-experts/plugins/writer");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({
      name: "writer",
      agentName: "writer",
      expertType: "agent",
      displayName: { zh: "写作专家", en: "Writer" },
      profession: { zh: "作者" },
      plugin: "writer",
    }),
  );
  await fs.writeFile(path.join(root, ".created-by-session"), "  CREATOR_SESSION_PROOF\n");
  const agent = path.join(root, "agents/writer.md");
  await fs.writeFile(agent, "First real instructions");
  let scan = await scanCustomExperts(config);
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.experts[0].name, "写作专家");
  assert.equal(scan.experts[0].createdBySession, "CREATOR_SESSION_PROOF");
  await fs.writeFile(path.join(root, ".created-by-session"), " ");
  assert.equal((await scanCustomExperts(config)).experts[0].createdBySession, null);
  await fs.writeFile(path.join(root, ".created-by-session"), "CREATOR_FOR_CLEAR");
  const { clearCustomExpertSessionMarker } = require("../custom-experts.cjs");
  await clearCustomExpertSessionMarker(config, "../writer");
  assert.equal(
    await fs.readFile(path.join(root, ".created-by-session"), "utf8"),
    "CREATOR_FOR_CLEAR",
  );
  await clearCustomExpertSessionMarker(config, "custom-expert:writer");
  assert.equal((await scanCustomExperts(config)).experts[0].createdBySession, null);
  await assert.rejects(
    fs.access(path.join(root, ".created-by-session")),
    (error) => error.code === "ENOENT",
  );
  await clearCustomExpertSessionMarker(config, "writer");

  assert.equal(scan.experts[0].plugin, null);
  assert.equal(scan.experts[0].nativePluginRuntimeAvailable, false);
  await fs.writeFile(agent, "Edited instructions");
  scan = await scanCustomExperts(config);
  assert.equal(scan.experts[0].systemPrompt, "Edited instructions");
  const outside = path.join(config, "outside.md");
  await fs.writeFile(outside, "private");
  await fs.rename(agent, agent + ".saved");
  await fs.symlink(outside, agent);
  scan = await scanCustomExperts(config);
  assert.equal(scan.experts.length, 0);
  assert.match(scan.errors[0].message, /escapes/);
});
test("deleting a local expert archives its files and future scans do not reimport it", async () => {
  const { archiveCustomExpert } = require("../custom-experts.cjs");
  const config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-custom-expert-delete-"));
  const root = path.join(config, "plugins/marketplaces/my-experts/plugins/author");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.writeFile(
    path.join(root, ".codebuddy-plugin/plugin.json"),
    JSON.stringify({ name: "author", agentName: "author", expertType: "agent" }),
  );
  await fs.writeFile(path.join(root, "agents/author.md"), "Keep these instructions recoverable");
  const archived = await archiveCustomExpert(config, "custom-expert:author");
  assert.equal((await scanCustomExperts(config)).experts.length, 0);
  assert.equal(
    await fs.readFile(path.join(archived.archivedPath, "agents/author.md"), "utf8"),
    "Keep these instructions recoverable",
  );
  await fs.rename(archived.archivedPath, archived.previousPath);
  assert.equal((await scanCustomExperts(config)).experts[0].id, "custom-expert:author");
  await assert.rejects(archiveCustomExpert(config, "custom-expert:missing"), /unavailable/);
});

test("ZIP import validates paths and installs real instructions without silent overwrite", async () => {
  const { installCustomExpertZip } = require("../custom-experts.cjs");
  const { execFile } = require("node:child_process"),
    { promisify } = require("node:util");
  const execute = promisify(execFile),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-zip-")),
    config = path.join(dir, "config"),
    zip = path.join(dir, "expert.zip");
  const make = async (entries) =>
    execute("python3", [
      "-c",
      'import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for n,c in json.loads(sys.argv[2]).items():z.writestr(n,c)',
      zip,
      JSON.stringify(entries),
    ]);
  const manifest = JSON.stringify({
    name: "writer",
    agentName: "writer",
    expertType: "agent",
    displayName: { zh: "写作专家" },
  });
  await make({
    "writer/.codebuddy-plugin/plugin.json": manifest,
    "writer/agents/writer.md": "Imported instructions",
  });
  const result = await installCustomExpertZip(config, zip);
  assert.equal(result.expertId, "custom-expert:writer");
  assert.equal((await scanCustomExperts(config)).experts[0].systemPrompt, "Imported instructions");
  await make({
    "writer/.codebuddy-plugin/plugin.json": manifest,
    "writer/agents/writer.md": "Updated instructions",
  });
  await assert.rejects(installCustomExpertZip(config, zip), /overwrite/);
  assert.equal((await scanCustomExperts(config)).experts[0].systemPrompt, "Imported instructions");
  await installCustomExpertZip(config, zip, true);
  assert.equal((await scanCustomExperts(config)).experts[0].systemPrompt, "Updated instructions");
  const archived = await fs.readdir(path.join(config, "expert-trash"));
  assert.equal(archived.length, 1);
  assert.equal(
    await fs.readFile(path.join(config, "expert-trash", archived[0], "agents/writer.md"), "utf8"),
    "Imported instructions",
  );
  await make({
    "../escape.txt": "bad",
    "writer/.codebuddy-plugin/plugin.json": manifest,
    "writer/agents/writer.md": "bad",
  });
  await assert.rejects(installCustomExpertZip(config, zip, true), /escapes/);
  assert.equal((await scanCustomExperts(config)).experts[0].systemPrompt, "Updated instructions");
});

test("exported expert ZIP preserves binary resources and imports into another profile", async () => {
  const { exportCustomExpert, installCustomExpertZip } = require("../custom-experts.cjs");
  const { readExpertZip } = require("../expert-zip.cjs");
  const config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-export-"));
  const root = path.join(config, "plugins/marketplaces/my-experts/plugins/writer");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  await fs.mkdir(path.join(root, "avatars"));
  const manifest = {
    name: "writer",
    agentName: "writer",
    expertType: "agent",
    displayName: { zh: "写作专家" },
    author: { name: "Original" },
  };
  await fs.writeFile(path.join(root, ".codebuddy-plugin/plugin.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "agents/writer.md"), "Round trip instructions");
  const binary = Buffer.from([0, 1, 2, 255, 128]);
  await fs.writeFile(path.join(root, "avatars/picture.png"), binary);
  const exported = await exportCustomExpert(config, "custom-expert:writer", "Export author");
  const files = await readExpertZip(exported.zipPath);
  assert.deepEqual(files.get("avatars/picture.png"), binary);
  assert.equal(JSON.parse(files.get(".codebuddy-plugin/plugin.json")).author.name, "Export author");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, ".codebuddy-plugin/plugin.json"))).author.name,
    "Original",
  );
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-reimport-"));
  await installCustomExpertZip(other, exported.zipPath);
  assert.equal((await scanCustomExperts(other)).experts[0].systemPrompt, "Round trip instructions");
  await fs.symlink(path.join(root, "agents/writer.md"), path.join(root, "link.md"));
  await assert.rejects(exportCustomExpert(config, "custom-expert:writer"), /links/);
});

test("ZIP reader rejects Windows paths, NUL names, links and tampered file bytes", async () => {
  const { createExpertZip, readExpertZip } = require("../expert-zip.cjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-expert-zip-boundaries-"));
  const filename = path.join(dir, "proof.zip");
  const manifest = Buffer.from(
    JSON.stringify({ name: "writer", agentName: "writer", expertType: "agent" }),
  );
  const valid = new Map([
    [".codebuddy-plugin/plugin.json", manifest],
    ["agents/writer.md", Buffer.from("Original instructions")],
  ]);
  for (const bad of [
    "../escape.txt",
    "writer/../escape.txt",
    "writer\\escape.txt",
    "C:/escape.txt",
    "/escape.txt",
    "nul\0name.txt",
  ]) {
    await fs.writeFile(filename, createExpertZip(new Map([...valid, [bad, Buffer.from("bad")]])));
    await assert.rejects(readExpertZip(filename), /escapes/);
  }
  const linked = createExpertZip(valid),
    central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  linked.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  await fs.writeFile(filename, linked);
  await assert.rejects(readExpertZip(filename), /links/);
  const tampered = createExpertZip(valid),
    offset = 30 + tampered.readUInt16LE(26);
  tampered[offset] ^= 1;
  await fs.writeFile(filename, tampered);
  await assert.rejects(readExpertZip(filename), /integrity/);
});

test("original workbuddy metadata directory imports scans and exports without losing its manifest path", async () => {
  const { createExpertZip, readExpertZip } = require("../expert-zip.cjs"),
    { installCustomExpertZip, exportCustomExpert } = require("../custom-experts.cjs"),
    config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-alternate-manifest-")),
    zip = path.join(config, "input.zip");
  const files = new Map([
    [
      "wrapper/.workbuddy-plugin/plugin.json",
      Buffer.from(
        JSON.stringify({
          name: "alternate-proof",
          agentName: "alternate-proof",
          expertType: "agent",
        }),
      ),
    ],
    ["wrapper/agents/alternate-proof.md", Buffer.from("ALTERNATE_PROMPT")],
  ]);
  await fs.writeFile(zip, createExpertZip(files));
  const result = await installCustomExpertZip(config, zip);
  assert.equal(result.success, true);
  const scan = await scanCustomExperts(config);
  assert.equal(scan.experts[0].systemPrompt, "ALTERNATE_PROMPT");
  assert.equal(scan.errors.length, 0);
  const exported = await exportCustomExpert(config, result.expertId);
  const output = await readExpertZip(exported.zipPath);
  assert(output.has(".workbuddy-plugin/plugin.json"));
  assert.equal(output.get("agents/alternate-proof.md").toString(), "ALTERNATE_PROMPT");
});

test("dual metadata directories use original codebuddy priority but separate package roots still fail", async () => {
  const { createExpertZip, readExpertZip } = require("../expert-zip.cjs"),
    { installCustomExpertZip } = require("../custom-experts.cjs"),
    config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-dual-manifest-")),
    zip = path.join(config, "dual.zip");
  const primary = {
      name: "dual-proof",
      agentName: "dual-proof",
      expertType: "agent",
      displayName: "PRIMARY",
    },
    secondary = {
      name: "secondary-proof",
      agentName: "dual-proof",
      expertType: "agent",
      displayName: "SECONDARY",
    };
  const files = new Map([
    ["wrapper/.workbuddy-plugin/plugin.json", Buffer.from(JSON.stringify(secondary))],
    ["wrapper/.codebuddy-plugin/plugin.json", Buffer.from(JSON.stringify(primary))],
    ["wrapper/agents/dual-proof.md", Buffer.from("DUAL_PROMPT")],
  ]);
  await fs.writeFile(zip, createExpertZip(files));
  const installed = await installCustomExpertZip(config, zip);
  assert.equal(installed.expertId, "custom-expert:dual-proof");
  assert.equal((await scanCustomExperts(config)).experts[0].name, "PRIMARY");
  assert.equal((await readExpertZip(zip)).has(".workbuddy-plugin/plugin.json"), true);
  files.set("other/.workbuddy-plugin/plugin.json", Buffer.from(JSON.stringify(secondary)));
  const multi = path.join(config, "multi.zip");
  await fs.writeFile(multi, createExpertZip(files));
  await assert.rejects(readExpertZip(multi), /exactly one expert package/);
});

test("expert import persists original legacy manifest list normalization into installed package", async () => {
  const { createExpertZip } = require("../expert-zip.cjs"),
    { installCustomExpertZip } = require("../custom-experts.cjs"),
    config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-normalized-import-")),
    zip = path.join(config, "input.zip"),
    manifest = {
      name: "normalized-proof",
      agentName: "normalized-proof",
      tags: { zh: ["甲", "乙"], en: ["A"] },
      quickPrompts: { zh: ["开始"] },
      triggerPrompts: "bad",
      connectorIds: { bad: true },
      references: "bad",
    };
  await fs.writeFile(
    zip,
    createExpertZip(
      new Map([
        [".codebuddy-plugin/plugin.json", Buffer.from(JSON.stringify(manifest))],
        ["agents/normalized-proof.md", Buffer.from("NORMALIZED_PROMPT")],
      ]),
    ),
  );
  const installed = await installCustomExpertZip(config, zip),
    saved = JSON.parse(
      await fs.readFile(path.join(installed.localPath, ".codebuddy-plugin/plugin.json"), "utf8"),
    );
  assert.deepEqual(saved.tags, [{ zh: "甲", en: "A" }, { zh: "乙" }]);
  assert.deepEqual(saved.quickPrompts, [{ zh: "开始" }]);
  assert.deepEqual(saved.triggerPrompts, []);
  assert.deepEqual(saved.connectorIds, []);
  assert.deepEqual(saved.references, []);
  assert.equal(saved.name, manifest.name);
});

test("team packages register their lead instructions without claiming team runtime", async () => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), "wb-team-product-"));
  const root = path.join(config, "plugins/marketplaces/my-experts/plugins/editor-team");
  await fs.mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"));
  const manifest = {
    name: "editor-team", expertType: "team", displayName: { zh: "编辑专家团" },
    teamInfo: { leadAgent: "editor-lead" },
    members: [{ agent_name: "editor-lead", id: "market-id", name: { zh: "主编" }, role: "lead" }],
  };
  const file = path.join(root, ".codebuddy-plugin/plugin.json");
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "agents/editor-lead.md"), "Coordinate editing tasks.");
  const scan = await scanCustomExperts(config);
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.experts[0].name, "编辑专家团");
  assert.equal(scan.experts[0].agentName, "editor-lead");
  assert.deepEqual(scan.experts[0].members, manifest.members.map(member => ({ ...member, id: "editor-lead" })));
  assert.equal(scan.experts[0].systemPrompt, "Coordinate editing tasks.");
  assert.equal(scan.experts[0].runtimeAvailable, false);
  await fs.writeFile(file, JSON.stringify({ ...manifest, teamInfo: { leadAgent: "../outside" } }));
  assert.equal((await scanCustomExperts(config)).experts.length, 0);
});
