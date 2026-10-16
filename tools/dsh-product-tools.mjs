// Mounted only by our isolated dsh SDK profile. Product policy remains authoritative.
export const name = "workbuddy-product-tools";
export const inject = ["tools"];
export function apply(ctx, config) {
  for (const tool of config.tools || []) ctx.tools.register({
    ...tool,
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args, exec) {
      const response = await fetch(process.env.WB_DSH_TOOL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.WB_DSH_TOOL_TOKEN },
        body: JSON.stringify({ name: tool.name, args }), signal: exec.signal,
      });
      if (!response.ok) throw Error("Product tool bridge unavailable: HTTP " + response.status);
      const result = await response.json();
      if (result.error) throw Error(result.error);
      return JSON.stringify(result);
    },
  });
}
