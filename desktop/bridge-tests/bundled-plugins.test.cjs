const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {createBundledPlugins,MARKETPLACE}=require("../bundled-plugins.cjs");
test("real manifests map all child seed skills; state toggles persist without runtime claims",async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"wb-plugins-test-")),changes=[];
 const opts={dataDir,applySkillChanges:async batch=>changes.push(batch)};
 const plugins=createBundledPlugins(opts),list=await plugins.getInstalled();
 assert.deepEqual(list.map(x=>x.name).sort(),["sheetagent","tencent-docs-plugin","tencent-docx","tencent-pptx","weixinpay"].sort());
 assert.equal(list.find(x=>x.name==="sheetagent").skills.length,2);
 assert.ok(list.find(x=>x.name==="tencent-docx").skills.some(s=>s.resourcePath.endsWith("/skills/humanizer-zh/SKILL.md")));
 assert.ok(list.every(x=>x.runtimeAvailable===false));
 const result=await plugins.batchToggle({items:[{pluginName:"sheetagent",marketplaceName:MARKETPLACE,scope:"user",operation:"disable"},{pluginName:"missing",operation:"enable"}]});
 assert.equal(result.success,false);assert.equal(result.succeededPlugins[0].operation,"disable");assert.equal(result.failedPlugins.length,1);
 assert.ok(changes[0].every(s=>s.enabled===false));assert.equal((await createBundledPlugins(opts).getInstalled()).find(p=>p.name==="sheetagent").enabled,false);
 await plugins.uninstall("sheetagent",MARKETPLACE,"user");assert.ok(!(await plugins.list()).some(p=>p.name==="sheetagent"));
 assert.equal((await plugins.list({includeUninstalled:true})).find(p=>p.name==="sheetagent").uninstalled,true);
 await plugins.restore("sheetagent");assert.equal((await plugins.list()).find(p=>p.name==="sheetagent").enabled,true);assert.ok(changes.at(-1).every(s=>s.enabled));
});
test("missing child adapter prevents state mutation and rejected callback cannot report success",async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"wb-plugins-fail-"));
 const missing=createBundledPlugins({dataDir});await assert.rejects(missing.uninstall("sheetagent"),/adapter required/);
 const bad=createBundledPlugins({dataDir,applySkillChanges:async()=>{throw Error("REST unavailable");}});
 const result=await bad.batchToggle({items:[{pluginName:"sheetagent",operation:"disable"}]});assert.equal(result.success,false);assert.match(result.failedPlugins[0].error,/REST unavailable/);assert.equal((await bad.list()).find(p=>p.name==="sheetagent").enabled,true);
});
test("original marketplace contracts expose stable id, array and installed status fields",async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"wb-plugins-market-"));
 const plugins=createBundledPlugins({dataDir,applySkillChanges:async()=>{}});
 const markets=await plugins.getMarketplaces();assert.equal(markets[0].id,MARKETPLACE);assert.equal(markets[0].type,"local");assert.equal(markets[0].isBuiltIn,true);
 const items=await plugins.getMarketplacePlugins(MARKETPLACE);assert.equal(items.length,5);assert.ok(items.every(p=>p.status==="enabled"&&p.installedScopes[0]==="user"&&p.installedScopesStatus.user===true&&p.installedPath));
 assert.equal((await plugins.getMarketplacePlugins(MARKETPLACE,false,"sheetagent")).length,1);
 await plugins.uninstall("sheetagent");const removed=(await plugins.getMarketplacePlugins(MARKETPLACE)).find(p=>p.name==="sheetagent");assert.equal(removed.status,"not-installed");assert.deepEqual(removed.installedScopes,[]);
});
