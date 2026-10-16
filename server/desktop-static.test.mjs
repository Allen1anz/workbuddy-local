import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./app.mjs";

test("expert images remain available when a new renderer uses a different static root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-shared-expert-images-"));
  const server = createAppServer({ dataDir: path.join(root, "data"), staticDir: path.join(root, "different-renderer") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const asset of ["avatars/ContentCreator.png", "scene-images/scene-content-creation-header.png"]) {
    const response = await fetch(origin + "/expert-catalog-assets/" + asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const original = await fs.readFile(fileURLToPath(new URL("../desktop-ui/expert-catalog-assets/" + asset, import.meta.url)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  }
  assert.equal((await fetch(origin + "/expert-catalog-assets/missing.png")).status, 404);
  assert.equal((await fetch(origin + "/expert-catalog-assets/%2e%2e%2fpackage.json")).status, 403);
  assert.equal((await fetch(origin + "/expert-catalog-assets/avatars/ContentCreator.png", { method: "POST" })).status, 405);
});

test("bundled model settings expose both Tencent regions and exact completion endpoints", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-model-settings-"));
  const server = createAppServer({ dataDir: root });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/product/model-settings`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.providers.length, 16);
  const providers = new Map(config.providers.map(provider => [provider.id, provider]));
  assert.equal(providers.get("tencent-token-plan-pro").endpoint, "https://tokenhub.tencentmaas.com/plan/v3/chat/completions");
  assert.equal(providers.get("tencent-token-plan-pro-sg").endpoint, "https://tokenhub-intl.tencentmaas.com/plan/v3/chat/completions");
  assert.equal(providers.get("tencent-tokenhub-sg").endpoint, "https://tokenhub-intl.tencentmaas.com/v1/chat/completions");
  assert.equal(providers.get("custom").endpointMode, "editable");
});

test("desktop routes refresh while missing assets do not return HTML", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-desktop-static-"));
  const staticDir = path.join(root, "ui");
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, "index.html"), "<main>desktop</main>");
  await fs.writeFile(path.join(staticDir, "font.woff2"), "font");
  const server = createAppServer({ dataDir: path.join(root, "data"), staticDir, staticFallback: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const route = await fetch(origin + "/experts/local");
  assert.equal(route.status, 200);
  assert.match(route.headers.get("content-type"), /text\/html/);
  assert.equal(await route.text(), "<main>desktop</main>");
  const font = await fetch(origin + "/font.woff2");
  assert.equal(font.headers.get("content-type"), "font/woff2");
  const missing = await fetch(origin + "/assets/missing.js");
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /<main>desktop/);
});

test("renderer drift returns an explicit failure instead of a successful empty module", async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wb-static-drift-"));
  const staticDir=path.join(root,"ui");await fs.mkdir(path.join(staticDir,"assets"),{recursive:true});
  await fs.writeFile(path.join(staticDir,"assets/skills-CzOlJP4U.js"),"export const changed=true;");
  const server=createAppServer({dataDir:path.join(root,"data"),staticDir});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/assets/skills-CzOlJP4U.js`);
  assert.equal(response.status,500);assert.match(response.headers.get("content-type"),/application\/json/);
  const body=await response.json();assert.equal(body.error,"Desktop resource adaptation failed");assert.match(body.detail,/skill state binding changed/);
});

test("all current adapted desktop assets return complete JavaScript", async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wb-static-adapters-"));
  const staticDir=fileURLToPath(new URL("../desktop-ui/",import.meta.url));
  const server=createAppServer({dataDir:path.join(root,"data"),staticDir});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  for(const name of ["skills-CzOlJP4U.js","expert-picker-uOJU4MNV.js","use-inspiration-share-code-receiver-DyhZtfQL.js","index-BZi9u85P.js","components-CFbjBHF1.js","hooks-tYu87aVj.js"]){
    const response=await fetch(`http://127.0.0.1:${server.address().port}/assets/${name}`);
    assert.equal(response.status,200,name);assert.match(response.headers.get("content-type"),/text\/javascript/);
    const source=await response.text();assert(source.length>1000,name);assert.match(source,/export\s*\{/,name);
  }
});
