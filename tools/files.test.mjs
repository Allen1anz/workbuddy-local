import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/app.mjs";
import { filesRoutes } from "./files.mjs";

test("file editor detects conflicts and prevents accidental overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-files-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "notes.txt"), "original");
  const app = createAppServer({
    dataDir: join(dir, "data"),
    extraRoutes: filesRoutes(join(dir, "data")),
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = "GET", body) =>
    fetch(url + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await request("/api/config", "PUT", { workspace });
    const listing = await (await request("/api/files?path=.")).json();
    assert.equal(listing.entries[0].name, "notes.txt");
    const file = await (await request("/api/files/content?path=notes.txt")).json();
    assert.equal(file.text, "original");
    const body = {
      path: "notes.txt",
      content: "edited",
      expectedSha256: file.sha256,
      expectedWorkspace: listing.workspace,
    };
    assert.equal((await request("/api/files/content", "PUT", body)).status, 200);
    assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "edited");
    assert.equal((await request("/api/files/content", "PUT", body)).status, 409);
    assert.equal(
      (
        await request("/api/files/content", "PUT", {
          path: "notes.txt",
          content: "overwrite",
          expectedSha256: null,
          expectedWorkspace: listing.workspace,
        })
      ).status,
      409,
    );
    assert.equal((await request("/api/files/content?path=../workbuddy.sqlite")).status, 400);
    assert.equal(
      (
        await request("/api/files/content", "PUT", {
          path: "new.txt",
          content: "new",
          expectedSha256: null,
          expectedWorkspace: listing.workspace,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/files/content", "PUT", {
          path: "new.txt",
          content: "changed",
          expectedSha256: "wrong",
          expectedWorkspace: "other",
        })
      ).status,
      409,
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
