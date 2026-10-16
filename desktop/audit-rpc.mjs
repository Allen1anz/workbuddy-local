import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const original = JSON.parse(
  await fs.readFile(
    path.join(root, "../workbuddy-analysis/desktop-equivalence-ledger.json"),
    "utf8",
  ),
);
const contract = JSON.parse(
  await fs.readFile(path.join(root, "../workbuddy-analysis/desktop-ui-contract.json"), "utf8"),
);
const types = new Map(contract.daemon_methods.map((row) => [row.method, row.type]));
const branches = new Map();
for (const name of ["dispatcher.cjs", "native-dispatch.cjs"]) {
  const filename = path.join(root, "desktop", name),
    source = await fs.readFile(filename, "utf8");
  for (const match of source.matchAll(/case\s+["']([^"']+)["']\s*:/g)) {
    branches.set(match[1], {
      file: filename,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
}
const rows = original.rows.map((row) => ({
  channel: row.channel,
  method: row.method,
  type: types.get(row.method) || "unknown",
  original: row.original,
  adapter: branches.get(row.channel) || null,
  staticStatus: branches.has(row.channel) ? "literal_case_present" : "literal_case_missing",
  equivalence: "not_proven_by_static_inventory",
}));
const groups = {};
for (const row of rows) {
  const group = typeof row.channel === "string" ? row.channel.split(":")[0] : "unresolved_channel";
  const entry = (groups[group] ||= { total: 0, present: 0, missing: [] });
  entry.total++;
  if (row.adapter) entry.present++;
  else entry.missing.push(row.channel);
}
const present = rows.filter((row) => row.adapter).length;
const report = {
  date: new Date().toISOString(),
  scope:
    "Original 590 method entries; includes event subscriptions and unresolved channels. Literal switch cases only; missing event cases are not missing invocation implementations. Dynamic routing may be missed, present branches may still reject or be incomplete. Neither presence nor tests prove full equivalence.",
  counts: {
    total: rows.length,
    literalCasePresent: present,
    literalCaseMissing: rows.length - present,
    invocationCasesMissing: rows.filter((row) => row.type === "invoke" && !row.adapter).length,
    unresolvedChannels: rows.filter((row) => !row.channel).length,
  },
  groups,
  rows,
};
await fs.writeFile(
  path.join(root, "artifacts/desktop-rpc-current-inventory.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report.counts));
for (const key of ["expert", "skill", "config", "plugin", "automation", "ima", "team"])
  if (groups[key]) console.log(JSON.stringify({ group: key, ...groups[key] }));
