/** Run bounded, read-only specialist tasks against the selected model. */
export function teamTool() {
  return {
    definition: {
      type: "function",
      function: {
        name: "team_delegate",
        description:
          "Ask 1 to 4 independent specialists to analyze tasks in parallel using the configured model. They have no filesystem, shell, or MCP access. Results are model-generated analysis, not observations. Requires approval before sending task text and starting additional model requests.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                properties: { role: { type: "string" }, task: { type: "string" } },
                required: ["role", "task"],
                additionalProperties: false,
              },
            },
          },
          required: ["tasks"],
        },
      },
    },
    requiresApproval: true,
    handler: async ({ tasks }, { config, signal }) => {
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 4)
        throw new Error("每次可委派 1–4 个角色任务。");
      for (const task of tasks) {
        if (
          typeof task.role !== "string" ||
          typeof task.task !== "string" ||
          !task.task.trim() ||
          task.task.length > 40_000
        )
          throw new Error("角色与任务必须为文本，任务不超过 40000 字。");
      }
      const results = await Promise.allSettled(
        tasks.map(async ({ role, task }) => {
          const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.model,
              stream: false,
              messages: [
                {
                  role: "system",
                  content: `You are a read-only specialist with role: ${role}. Analyze only the supplied task. You have no tool access. Never claim that you inspected files, ran code, or changed anything. Distinguish supplied facts, your inferences, and unknowns. Return a concise usable result for the lead assistant.`,
                },
                { role: "user", content: task },
              ],
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`模型接口返回 HTTP ${response.status}`);
          }
          const json = await response.json();
          const content = json.choices?.[0]?.message?.content;
          if (typeof content !== "string" || !content.trim())
            throw new Error("模型没有返回文本结果。");
          return { role, content };
        }),
      );
      if (signal.aborted) throw new Error("任务已取消。");
      return {
        authority: "model-analysis",
        limitation:
          "Specialists analyze supplied text only; no actions or independent external observations were performed.",
        results: results.map((result, index) =>
          result.status === "fulfilled"
            ? { status: "completed", ...result.value }
            : { role: tasks[index].role, status: "failed", error: result.reason.message },
        ),
      };
    },
  };
}
