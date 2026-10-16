/** Test configured model credentials with a fixed non-sensitive message. */
export function modelRoutes() {
  return async (req, res, url, { config }) => {
    if (url.pathname !== "/api/model/test" || req.method !== "POST") return false;
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (!config.model || !config.baseURL) {
      json(400, { error: "请先保存接口地址与模型名。" });
      return true;
    }
    try {
      const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Reply with exactly the word OK." }],
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`接口返回 HTTP ${response.status}。请核对地址、模型名和密钥。`);
      }
      const result = await response.json();
      if (result.error || !Array.isArray(result.choices) || !result.choices.length)
        throw new Error("接口未返回 OpenAI 兼容的 choices 响应。");
      json(200, { ok: true, model: config.model });
    } catch (error) {
      const message =
        error.name === "TimeoutError" ? "连接超过 30 秒，请检查接口地址与网络。" : error.message;
      json(400, { error: message });
    }
    return true;
  };
}
