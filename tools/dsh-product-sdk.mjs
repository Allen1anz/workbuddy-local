import path from "node:path";
import { pathToFileURL } from "node:url";
export const name = "workbuddy-sdk-transport";
export const inject = ["agents", "llm", "sessionPersistence"];

// Transport adapter only: DSH owns the agent loop, tools, and durable sessions.
export async function apply(ctx, config) {
  const load = relative => import(pathToFileURL(path.join(config.repository, relative)).href);
  const [{ JsonRpcLineTransport }, { createUserMessage }] = await Promise.all([
    load("packages/sdk/protocol/lib/index.js"), load("packages/llm/llm/lib/index.js"),
  ]);
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const handles = new Map();
  let selection, stopping = false, shutdownTask;
  ctx.on("session/event", (session, event) => transport.notify("session.event", { sessionId: String(session.id), event }));
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (frame.type === "chunk" && frame.chunk.type === "text-delta") transport.notify("workbuddy/text", { sessionId: String(agent.session.id), text: frame.chunk.text });
  });
  ctx.on("agent/status", ({ agent, status }) => transport.notify("session.status", { sessionId: String(agent.session.id), status }));
  const shutdown = () => shutdownTask ??= (async () => {
    stopping = true;
    await Promise.all([...handles.values()].map(handle => handle.dispose()));
    handles.clear();
    await ctx.sessionPersistence.flush();
  })();
  transport.onRequest(async (method, params) => {
    if (method === "initialize") {
      await ctx.get("loader")?.await();
      if (selection) throw Error("Already initialized");
      if (!params || !path.isAbsolute(params.cwd || "") || typeof params.provider !== "string" || typeof params.model !== "string") throw Error("Invalid SDK initialization");
      await ctx.llm.resolveCallConfig({ provider: params.provider, model: params.model, maxTokens: params.maxTokens });
      selection = params;
      return { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "workbuddy-adapter-1" } };
    }
    if (method === "shutdown") {
      await shutdown();
      setImmediate(async () => { await transport.flush(); await ctx.root.fiber.dispose(); process.exit(0); });
      return {};
    }
    if (!selection || stopping) throw Error("DSH runtime is not ready");
    if (method === "session/prompt") {
      if (typeof params?.sessionId !== "string" || !params.sessionId || !Array.isArray(params.contentBlocks) || params.contentBlocks.some(block => block.type !== "text" || typeof block.text !== "string")) throw Error("Invalid SDK text prompt");
      let handle = handles.get(params.sessionId);
      if (!handle) {
        const agentOptions = { provider: selection.provider, model: selection.model, maxTokens: selection.maxTokens };
        const exists = await ctx.sessionPersistence.stat(params.sessionId);
        handle = exists
          ? await ctx.agents.resume({ resumeSessionId: params.sessionId, agentOptions })
          : await ctx.agents.create({ sessionId: params.sessionId, meta: { cwd: selection.cwd }, agentOptions });
        handles.set(params.sessionId, handle);
      }
      const message = createUserMessage({ content: params.contentBlocks, source: { kind: "user" } });
      handle.agent.followup(message);
      return { messageId: message.id };
    }
    if (method === "workbuddy/cancel") {
      handles.get(params?.sessionId)?.agent.cancel({ kind: "user" });
      return {};
    }
    throw Error("Unsupported DSH method: " + method);
  });
  ctx.effect(() => { transport.start(); return async () => { await shutdown(); transport.close(); }; }, "workbuddy.sdk");
}
