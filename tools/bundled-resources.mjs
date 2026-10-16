import fs from "node:fs/promises";
import path from "node:path";

/** Read published skill references without executing scripts or exposing app data. */
export function bundledResourcesTool(root = path.resolve(import.meta.dirname, "../desktop-resources")) {
  return {
    definition: {
      type: "function",
      function: {
        name: "bundled_resource_read",
        description: "Read a bundled skill/expert text reference by resourcePath. Resolve relative references from the selected skill's resourcePath directory. This only reads packaged resources; scripts are never executed. Vendor cloud/native tools mentioned in references may be unavailable.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { resourcePath: { type: "string" } }, required: ["resourcePath"],
        },
      },
    },
    requiresApproval: false,
    handler: async ({ resourcePath }) => {
      if (typeof resourcePath !== "string" || !resourcePath.startsWith("vendor/") || path.isAbsolute(resourcePath))
        throw Error("Expected a vendor/ packaged resourcePath");
      const base = await fs.realpath(path.join(root, "vendor"));
      const file = await fs.realpath(path.resolve(root, resourcePath));
      if (!file.startsWith(base + path.sep)) throw Error("Resource path escapes bundled resources");
      if (![".md", ".txt", ".json", ".tpl", ".yaml", ".yml", ".html", ".css", ".py", ".js"].includes(path.extname(file)))
        throw Error("Only text references are readable");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 500000) throw Error("Resource is not a text file at most 500 KB");
      return { resourcePath, content: await fs.readFile(file, "utf8"), executed: false };
    },
  };
}
