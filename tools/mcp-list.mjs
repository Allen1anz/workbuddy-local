export async function collectMcpList(client, method, field, options = {}) {
  const values = [],
    cursors = new Set();
  let cursor;
  for (;;) {
    const page = await client[method](cursor === undefined ? {} : { cursor }, {
      timeout: 15000,
      ...options,
    });
    if (!Array.isArray(page[field])) throw Error(`Invalid MCP ${field} list`);
    values.push(...page[field]);
    if (page.nextCursor === undefined) return { [field]: values };
    if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor))
      throw Error("MCP pagination cursor repeated or invalid");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
