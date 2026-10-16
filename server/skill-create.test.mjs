import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
import { skillTextMetadata } from "../desktop/skill-metadata.cjs";
const valid={name:"creation-proof",description:"测试描述：包含特殊字符与换行\n第二行",instructions:"只回复技能创建可用。"};
const listen=async s=>{await new Promise(r=>s.listen(0,"127.0.0.1",r));return "http://127.0.0.1:"+s.address().port;};
test("new skill creation gates selection, validation, approval and duplicate writes",async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),"wb-skill-create-"));let round=0,args=valid;
 const model=http.createServer(async(req,res)=>{for await(const chunk of req){}res.writeHead(200,{"Content-Type":"text/event-stream"});const delta=round++%2===0?{tool_calls:[{index:0,id:"create",function:{name:"skill_instructions_create",arguments:JSON.stringify(args)}}]}:{content:"Finished"};res.end("data: "+JSON.stringify({choices:[{delta}]})+"\n\ndata: [DONE]\n\n");});
 const modelUrl=await listen(model),app=createAppServer({dataDir:path.join(profile,"data")}),url=await listen(app);
 const api=async(route,method="GET",body)=>{const res=await fetch(url+"/api"+route,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try{
  await api("/config","PUT",{baseURL:modelUrl+"/v1",model:"fixture"});
  const creator=await api("/skills","POST",{name:"skill-creator",content:"---\nname: skill-creator\n---\nCreate skills"});
  for(const scenario of ["unselected","invalid","ask","deny","create","duplicate"]){
   round=0;args=scenario==="invalid"?{...valid,name:123}:valid;const session=await api("/sessions","POST",{title:scenario});
   const response=await fetch(url+"/api/sessions/"+session.id+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:"Create a skill",mode:scenario==="ask"?"ask":"craft",skillIds:scenario==="unselected"?[]:[creator.id]})});const reader=response.body.getReader();let output="",decided=false;
   for(;;){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);if(!decided&&output.includes("event: approval")){const pending=await api("/approvals");assert.equal(pending[0].name,"skill_instructions_create");await api("/approvals/"+pending[0].id,"POST",{decision:scenario==="deny"?"deny":"approve"});decided=true;}}
   if(["unselected","invalid","ask","duplicate"].includes(scenario))assert.equal(decided,false);
   if(scenario==="unselected")assert.match(output,/Select skill-creator/);
   if(scenario==="invalid")assert.match(output,/Invalid skill name/);
   if(scenario==="ask")assert.match(output,/Ask mode forbids/);
   if(scenario==="duplicate")assert.match(output,/already exists/);
   const found=(await api("/skills")).filter(s=>s.name===valid.name);assert.equal(found.length,["create","duplicate"].includes(scenario)?1:0);
   if(found.length){const text=await fs.readFile(path.join(found[0].localRootDir,"SKILL.md"),"utf8");assert.equal(skillTextMetadata(text).description,valid.description);assert.match(text,/只回复技能创建可用/);assert.equal(found[0].securityScanPerformed,false);}
  }
 }finally{await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]);}
});

test("two approved same-name creations register only one installed package", async () => {
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),"wb-skill-create-race-"));
 const model=http.createServer(async(req,res)=>{
  let body="";for await(const c of req)body+=c;const request=JSON.parse(body);
  const delta=request.messages.some(m=>m.role==="tool")?{content:"Finished"}:{tool_calls:[{index:0,id:"create",function:{name:"skill_instructions_create",arguments:JSON.stringify(valid)}}]};
  res.writeHead(200,{"Content-Type":"text/event-stream"});res.end("data: "+JSON.stringify({choices:[{delta}]})+"\n\ndata: [DONE]\n\n");
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir:path.join(profile,"data")}),url=await listen(app);
 const api=async(route,method="GET",body)=>{const res=await fetch(url+"/api"+route,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try {
  await api("/config","PUT",{baseURL:modelUrl+"/v1",model:"fixture"});
  const creator=await api("/skills","POST",{name:"skill-creator",content:"---\nname: skill-creator\n---\nCreate skills"});
  const sessions=await Promise.all([api("/sessions","POST",{title:"first"}),api("/sessions","POST",{title:"second"})]);
  const outputs=sessions.map(async session=>{const response=await fetch(url+"/api/sessions/"+session.id+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:"Create skill",mode:"craft",skillIds:[creator.id]})});return response.text();});
  let approvals=[];
  for(let i=0;i<100;i++){approvals=await api("/approvals");if(approvals.length===2)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(approvals.length,2);
  await Promise.all(approvals.map(a=>api("/approvals/"+a.id,"POST",{decision:"approve"})));
  const results=await Promise.all(outputs);assert.equal(results.filter(x=>x.includes("Skill already exists")).length,1);
  assert.equal((await api("/skills")).filter(x=>x.name===valid.name).length,1);
  assert.equal((await fs.readdir(path.join(profile,"data/skills"))).length,1);
 } finally { await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]); }
});
