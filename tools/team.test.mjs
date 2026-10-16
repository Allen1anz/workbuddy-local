import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { teamTool } from "./team.mjs";

test("specialists execute concurrently, without tools, and preserve partial failures", async () => {
  let active = 0,
    maximum = 0;
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 2);
    active++;
    maximum = Math.max(active, maximum);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
    if (request.messages[1].content === "fail") {
      res.writeHead(503);
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Specialist analysis" } }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tool = teamTool();
    assert.equal(tool.requiresApproval, true);
    const result = await tool.handler(
      {
        tasks: [
          { role: "产品", task: "review" },
          { role: "研发", task: "fail" },
        ],
      },
      {
        config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "protocol-test" },
        signal: new AbortController().signal,
      },
    );
    assert.equal(maximum, 2);
    assert.equal(result.results[0].status, "completed");
    assert.equal(result.results[1].status, "failed");
    assert.equal(result.authority, "model-analysis");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
