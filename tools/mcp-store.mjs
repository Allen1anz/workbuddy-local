import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatMcpConfig, parseMcpConfig } from "./mcp-config.mjs";
export function createMcpStore(dataDir, { onExternalChange = () => {} } = {}) {
  const legacy = join(dataDir, "connectors.json"),
    document = join(dataDir, "mcp.json");
  let queue = Promise.resolve(),
    validationError = null;
  const run = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const readOptional = async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  async function atomic(file, content) {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async function loadUnlocked() {
    const raw = await readOptional(legacy),
      previous = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(previous)) throw Error("Invalid internal connector configuration");
    const user = await readOptional(document);
    if (user === null) {
      await atomic(document, formatMcpConfig(previous));
      validationError = null;
      return previous;
    }
    let next;
    try {
      next = parseMcpConfig(user, previous);
      validationError = null;
    } catch (error) {
      validationError = error.message;
      return previous;
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      await atomic(legacy, JSON.stringify(next, null, 2));
      onExternalChange();
    }
    return next;
  }
  return {
    load: () => run(loadUnlocked),
    getDocument: () =>
      run(async () => {
        await loadUnlocked();
        return {
          filePath: document,
          content: await readFile(document, "utf8"),
          ...(validationError ? { validationError } : {}),
        };
      }),
    save: (entries) =>
      run(async () => {
        const previous = await readOptional(legacy),
          normalized = parseMcpConfig(formatMcpConfig(entries), entries),
          next = JSON.stringify(normalized, null, 2),
          user = formatMcpConfig(normalized);
        await atomic(legacy, next);
        try {
          await atomic(document, user);
          validationError = null;
        } catch (error) {
          await atomic(legacy, previous || "[]");
          throw error;
        }
      }),
  };
}
