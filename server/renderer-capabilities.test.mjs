import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { adaptRendererCapabilities } from "./renderer-capabilities.mjs";
test("5.8.3 local appearance identity fallback does not grant official subscription access", () => {
  const source = 'function access(e,t){let n=e?.editionType,r=e?.enterpriseId?.trim()??``;return t?!!n&&!r&&n!=="ultimate":false}function edition(t){let l=t?.editionType,u=t?.expireAt;return l}';
  const adapted = adaptRendererCapabilities("/assets/contexts-BNN7VV-R.js", Buffer.from(source)).toString();
  const api = vm.runInNewContext(adapted + ";({access,edition})");
  assert.equal(api.edition({isLocal:true}), "free");
  assert.equal(api.edition({}), undefined);
  assert.equal(api.edition({isLocal:true,editionType:"ultimate"}), "ultimate");
  assert.equal(api.access({isLocal:true}, true), true);
  assert.equal(api.access({}, true), false);
  assert.equal(api.access({editionType:"ultimate"}, true), false);
  assert.equal(api.access({isLocal:true,enterpriseId:"official-enterprise"}, true), false);
  assert.throws(() => adaptRendererCapabilities("/assets/contexts-BNN7VV-R.js", Buffer.from(source.replace("l=t?.editionType", "l=changed"))), /binding changed/);
});
test("manual skill installation failure never emits success or refreshes installed skills", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/components-CFbjBHF1.js", import.meta.url));
  const adapted = adaptRendererCapabilities(filename,await fs.readFile(filename)).toString();
  const start = adapted.indexOf("const executeInstallByPath = ");
  const end = adapted.indexOf("/** verdict 为空时点击",start);
  for (const throws of [false,true]) {
    const calls = [];
    const context = {
      import_react$29:{useCallback:fn=>fn},
      personalSkills:{installByPath:async()=>{if(throws)throw Error("installation failed");return {success:false,error:"installation failed"};}},
      pendingInstallPath:"/test-only/SKILL.md",uploadScanResult:{failureReason:"local_unavailable",md5:""},
      skipInstalledRef:{current:false},setShowUploadModal:value=>calls.push({modal:value}),
      setUploadScanResult:()=>{},setPendingInstallPath:()=>{},setUploading:value=>calls.push({uploading:value}),
      getLocalizedImportSkillError:value=>value,t:key=>key,getLocale:()=>"en",Error,
      toast:Object.assign(()=>{throw Error("must not claim success");},{error:value=>calls.push({error:value})}),
      notifySkillListRefresh:()=>{throw Error("must not refresh");},onSuccess:()=>{throw Error("must not succeed");},
    };
    const run=vm.runInNewContext(adapted.slice(start,end)+"\nexecuteInstallByPath",context);
    await run(true);
    assert.equal(calls.filter(x=>x.error).length,1);
    assert.equal(calls.at(-1).uploading,false);
  }
});
test("unavailable skill scanner enters a truthful failure state without automatically installing", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/components-CFbjBHF1.js", import.meta.url));
  const adapted = adaptRendererCapabilities(filename,await fs.readFile(filename)).toString();
  const start = adapted.indexOf("const runImportFlow = ");
  const end = adapted.indexOf("const desktopPick = useDesktopSkillPick(runImportFlow);",start);
  const flow = adapted.slice(start,end);
  for (const locale of ["zh-CN","en"]) {
    const calls = [];
    let result, selectedPath;
    const context = {
      import_react$29:{useCallback:fn=>fn},
      personalSkills:{importFromPath:async args=>{calls.push(args);throw Error("本地版本尚未接入技能安全扫描");},installByPath:()=>{throw Error("must not install");}},
      scanEnabled:true,autoInstallNonHighRisk:false,t:key=>key,onSuccess:()=>{throw Error("must not succeed");},
      host:{adapter:{getProductConfiguration:async()=>({})}},
      setUploading:value=>calls.push({uploading:value}),
      setUploadScanResult:value=>{result=value;},setPendingInstallPath:value=>{selectedPath=value;},
      getLocale:()=>locale,Error,String,
      toast:{error:()=>{throw Error("must use failure state");}},
    };
    const run = vm.runInNewContext(flow+"\nrunImportFlow",context);
    await run("/test-only/SKILL.md");
    assert.equal(selectedPath,"/test-only/SKILL.md");
    assert.equal(result.verdict,"");
    assert.equal(result.failureReason,"local_unavailable");
    assert.match(result.failureDetail,locale.startsWith("zh") ? /未经安全检测/ : /has not been scanned/);
    assert.equal(calls.filter(x=>x.folderPath).length,1);
    assert.equal(calls.find(x=>x.folderPath).securityCheck,true);
    assert.equal(calls.at(-1).uploading,false);
  }
});
test("expert package changes use the original force refresh with subscription cleanup", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/use-inspiration-share-code-receiver-DyhZtfQL.js", import.meta.url));
  const original = await fs.readFile(filename);
  const adapted = adaptRendererCapabilities(filename,original).toString();
  assert(adapted.includes('useEffect)(() => window.__wbOn?.("expert:packagesChanged"'));
  assert(adapted.includes("refresh().catch(() => {}); }), [refresh]"));
  assert(adapted.includes('current?.id?.startsWith("custom-expert:") ? allExperts.find(item => item.id === current.id) ?? null : current'));
  assert.deepEqual(await fs.readFile(filename),original);
  assert.throws(()=>adaptRendererCapabilities(filename,Buffer.from("upstream drift")),/expert center refresh hook changed/);
});
test("local appearance exposes base themes without inventing a billed account edition", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/hooks-tYu87aVj.js", import.meta.url));
  const original = await fs.readFile(filename);
  const adapted = adaptRendererCapabilities(filename, original).toString();
  const expression = adapted.match(/return (facadeAvailable && \(account\?\.isLocal[^\n]+);/)[1];
  for (const [account, facadeAvailable, expected] of [[{isLocal:true},true,true], [{},true,false], [{isLocal:true},false,false], [{editionType:"ultimate"},true,false], [{editionType:"free"},true,true]]) {
    assert.equal(vm.runInNewContext(expression, { account, facadeAvailable, edition:account.editionType, ENTERPRISE_EDITIONS:new Set(["ultimate","exclusive"]) }),expected);
  }
  assert(adapted.includes('account?.editionType ?? (account?.isLocal ? "free" : undefined)'));
  const runtime = fileURLToPath(new URL("../desktop-ui/assets/index-BZi9u85P.js", import.meta.url));
  const runtimeOriginal = await fs.readFile(runtime);
  assert(adaptRendererCapabilities(runtime,runtimeOriginal).toString().includes('account?.editionType ?? (account?.isLocal ? "free" : undefined)'));
  assert.deepEqual(await fs.readFile(filename),original);
  assert.deepEqual(await fs.readFile(runtime),runtimeOriginal);
  assert.throws(()=>adaptRendererCapabilities(runtime,Buffer.from("upstream drift")),/runtime account access changed/);
});
test("skill package notifications subscribe to reload and clean up without editing original asset", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/components-CFbjBHF1.js", import.meta.url));
  const original = await fs.readFile(filename);
  const adapted = adaptRendererCapabilities(filename, original).toString();
  assert(adapted.includes('window.__wbOn?.("skill:packagesChanged", () => loadSkills(true))'));
  assert(adapted.includes("sub.unsubscribe(); stopLocal?.();"));
  assert(adapted.includes('failureReason: "local_unavailable"'));
  assert(adapted.includes("该技能未经安全检测"));
  assert(adapted.includes("（安全检测未执行）"));
  assert(adapted.includes("This skill has not been scanned."));
  assert(adapted.includes("(security scan not performed)"));
  const description = adapted.match(/children: (scanResult.failureReason === "local_unavailable"[^\n]+)/)[1];
  assert.equal(vm.runInNewContext(description,{scanResult:{failureReason:"local_unavailable",failureDetail:"未经检测"},isTimeout:false,t:key=>key}),"未经检测");
  assert.equal(vm.runInNewContext(description,{scanResult:{failureReason:"timeout",failureDetail:"unused"},isTimeout:true,t:key=>key}),"skills.security.failed.timeoutContent");
  assert.deepEqual(await fs.readFile(filename), original);
  assert.throws(() => adaptRendererCapabilities(filename, Buffer.from("upstream changed")), /subscription changed/);
});
test("original data security badges honor explicit false independently of managed mode", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/hooks-tYu87aVj.js", import.meta.url));
  const original = await fs.readFile(filename);
  const adapted = adaptRendererCapabilities(filename, original).toString();
  for (const field of ["securityGatewayEnabled", "transmissionEncryptionEnabled"]) {
    assert.ok(adapted.includes(`dataSecurity && dataSecurity.${field} === false`));
    assert.ok(!adapted.includes(`managed && dataSecurity && dataSecurity.${field} === false`));
  }
  assert.deepEqual(await fs.readFile(filename), original);
  assert.ok(adapted.includes('!apiKey && !editingModel?.apiKeySet'));
  assert.ok(adapted.includes('apiKey && !isApiKeyCharacterSetValid(apiKey)'));
  const required = adapted.match(/if \((selectedProvider.authMode === "apiKey" && !apiKey[^\n]+)\) \{/)[1];
  for (const [editingModel, expected] of [[{ apiKeySet: true }, false], [{ apiKeySet: false }, true], [null, true]])
    assert.equal(vm.runInNewContext(required, { selectedProvider: { authMode: "apiKey" }, apiKey: "", editingModel }), expected);
  assert.equal(adaptRendererCapabilities("/assets/unrelated.js", original), original);
  assert.throws(() => adaptRendererCapabilities(filename, Buffer.from("changed upstream")), /appearance account access changed/);
});

test("unavailable local team reaches the runtime error before official billing confirmation", async () => {
  const filename = fileURLToPath(new URL("../desktop-ui/assets/use-inspiration-share-code-receiver-DyhZtfQL.js", import.meta.url));
  const adapted = adaptRendererCapabilities(filename, await fs.readFile(filename)).toString();
  const start = adapted.indexOf("const handleSummon = (0, import_react$27.useCallback)(async (expertIdentity, cardPosition, promptOverride) => {");
  const end = adapted.indexOf("const isExpertLoaded = ", start);
  for (const source of ["local-expert-package", "public-expert-catalog", "official"]) {
    const unavailable = source !== "official";
    const calls = [];
    const context = {
      import_react$27: { useCallback: fn => fn },
      findExpertByIdentity: () => ({ source, expertType: "team", runtimeAvailable: !unavailable }),
      account: { userId: "test" },
      performSummon: async id => { calls.push("runtime:" + id); return false; },
      shouldSkipTeamSummonConfirmation: () => false,
      setPendingTeamSummon: () => calls.push("billing"),
      setTeamSummonAcknowledged: () => {}, setTeamSummonDialogVisible: () => {},
    };
    const summon = vm.runInNewContext(adapted.slice(start, end) + "\nhandleSummon", context);
    await summon("team-id");
    assert.deepEqual(calls, unavailable ? ["runtime:team-id"] : ["billing"]);
  }
});

test("invalid local packages report errors while preserving healthy experts and clearing on retry", async () => {
 const filename=fileURLToPath(new URL("../desktop-ui/assets/expert-picker-uOJU4MNV.js",import.meta.url));
 const adapted=adaptRendererCapabilities(filename,await fs.readFile(filename)).toString();
 const start=adapted.indexOf('function useLocalExperts('),end=adapted.indexOf('var import_react$8;',start);
 const states=[];let result={experts:[{id:'healthy'}],errors:[{directory:'broken',message:'Invalid expert name'}]};
 const effects=[];let onPackages,unsubscribed=false;
 const context={useModuleHost:()=>({facades:{expert:{getCustomExperts:async()=>result}}}),getLocale:()=> 'zh',decorateExpertsWithImportSecurityRisk:x=>x,subscribeExpertImportSecurityRiskChange:()=>()=>{},window:{__wbOn:(channel,fn)=>{assert.equal(channel,"expert:packagesChanged");onPackages=fn;return()=>{unsubscribed=true;};}},console,import_react$8:{useState:v=>{const box={value:v};states.push(box);return[v,n=>box.value=n];},useRef:v=>({current:v}),useCallback:f=>f,useEffect:fn=>effects.push(fn)}};
 const hook=vm.runInNewContext(adapted.slice(start,end)+'\nuseLocalExperts',context)();
 await hook.refresh();assert.equal(states[0].value[0].id,'healthy');assert.match(states[3].value,/broken: Invalid expert name/);
 result={experts:[{id:'healthy'},{id:'repaired'}],errors:[]};await hook.refresh();assert.equal(states[0].value.length,2);assert.equal(states[3].value,null);
 const dispose=effects[0]();await onPackages();assert.equal(states[0].value.length,2);dispose();assert.equal(unsubscribed,true);
 const center=fileURLToPath(new URL("../desktop-ui/assets/use-inspiration-share-code-receiver-DyhZtfQL.js",import.meta.url));
 assert.match(adaptRendererCapabilities(center,await fs.readFile(center)).toString(),/toast\.error\(localExpertError\)/);
});

test("installed skill failures are visible without removing healthy skills or reporting false success",async()=>{
 const filename=fileURLToPath(new URL("../desktop-ui/assets/components-CFbjBHF1.js",import.meta.url));
 const adapted=adaptRendererCapabilities(filename,await fs.readFile(filename)).toString();
 const start=adapted.indexOf('const loadSkills = (0, import_react$28.useCallback)(async (silent = false) => {');
 const end=adapted.indexOf('(0, import_react$28.useEffect)(() => {',start);
 const errors=[],lists=[];let response={results:[{name:'healthy',source:'userSettings'}],errors:[{id:'broken-id',name:'broken-skill',message:'Missing SKILL.md'}]};
 const context={import_react$28:{useCallback:f=>f},loadSkillsRequestIdRef:{current:0},personalSkills:{list:async()=>response},setInstalledSkills:x=>lists.push(x),setRecommendedSkills:()=>{},setInstalledLoading:()=>{},setRecommendLoading:()=>{},setInstalledLoaded:()=>{},hasCacheRef:{current:false},normalizeSkill:x=>x,writeCache:()=>{},SKILLS_CACHE_KEY_INSTALLED:'test',getLocale:()=> 'zh',setInstalledLoadError:x=>errors.push(x),console:{warn:()=>{},log:()=>{}}};
 const load=vm.runInNewContext(adapted.slice(start,end)+'\nloadSkills',context);
 await load(true);assert.equal(lists.at(-1)[0].name,'healthy');assert.match(errors[0],/broken-skill: Missing SKILL.md/);
 response={results:[{name:'healthy'},{name:'repaired'}],errors:[]};await load(true);assert.equal(lists.at(-1).length,2);assert.equal(errors.length,2);assert.equal(errors[1],null);
});

test("persistent skill failure state reaches installed section through the actual state adapter",async()=>{
 const filename=fileURLToPath(new URL("../desktop-ui/assets/skills-CzOlJP4U.js",import.meta.url));
 const adapted=adaptRendererCapabilities(filename,await fs.readFile(filename)).toString();
 assert.match(adapted,/installedLoadError: installedSkillsHook\.installedLoadError/);
 const components=fileURLToPath(new URL("../desktop-ui/assets/components-CFbjBHF1.js",import.meta.url));
 const ui=adaptRendererCapabilities(components,await fs.readFile(components)).toString();
 assert.match(ui,/data\.installedLoadError && .*role: "alert"/);
});
