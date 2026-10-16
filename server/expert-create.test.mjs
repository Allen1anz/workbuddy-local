import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "./app.mjs";
import { createCustomExpert, prepareCustomExpert, scanCustomExperts } from "../desktop/custom-experts.cjs";
const args={name:"creation-proof",displayName:"创建验收专家",description:"只用于专家创建验收",instructions:"仅回复创建验收完成，不运行工具。"};
const listen=async server=>{await new Promise(r=>server.listen(0,"127.0.0.1",r));return "http://127.0.0.1:"+server.address().port;};
test("expert creation validates input and refuses existing package replacement",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"wb-create-package-"));
 for(const bad of [{...args,name:"../escape"},{...args,name:123},{...args,instructions:""},{...args,displayName:4}])assert.throws(()=>prepareCustomExpert(bad));
 const result=await createCustomExpert(root,args);assert.equal(result.expertId,"custom-expert:creation-proof");
 await assert.rejects(createCustomExpert(root,{...args,instructions:"replacement"}),/already exists/);
 assert.equal((await scanCustomExperts(root)).experts[0].systemPrompt,args.instructions);
});
for (const creationArgs of [args, {...args, expertType:"team", members:[{id:"main",name:"Lead",profession:"Editor"},{id:"reviewer",name:"Reviewer",profession:"Review",instructions:"Review text only."}]}]) {
test("expert creation requires manager selection and approval before registering: " + (creationArgs.expertType || "agent"),async()=>{
 const args=creationArgs;
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),"wb-create-api-"));let round=0;
 const model=http.createServer(async(req,res)=>{
  let body="";for await(const c of req)body+=c;const request=JSON.parse(body);
  if(args.expertType==="team" && request.tools?.some(t=>t.function.name==="expert_package_create")){assert.match(request.messages[0].content,/set expertType=team/);const tool=request.tools.find(t=>t.function.name==="expert_package_create").function;assert.equal(tool.parameters.properties.members.type,"array");assert.deepEqual(tool.parameters.required,["name","displayName","description","instructions"]);}
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  const delta=round++%2===0?{tool_calls:[{index:0,id:"create",function:{name:"expert_package_create",arguments:JSON.stringify(args)}}]}:{content:"Finished"};
  res.end("data: "+JSON.stringify({choices:[{delta}]})+"\n\ndata: [DONE]\n\n");
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir:path.join(profile,"data")}),url=await listen(app);
 const api=async(route,method="GET",body)=>{const res=await fetch(url+"/api"+route,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try{
  await api("/config","PUT",{baseURL:modelUrl+"/v1",model:"fixture"});
  const skill=await api("/skills","POST",{name:"expert-manager",content:"---\nname: expert-manager\n---\nCreate experts"});
  for(const scenario of ["unselected","deny","create"]){
   round=0;const session=await api("/sessions","POST",{title:scenario});
   const response=await fetch(url+"/api/sessions/"+session.id+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:"Create an expert",mode:"craft",skillIds:scenario==="unselected"?[]:[skill.id]})});
   const reader=response.body.getReader();let output="",decided=false;
   for(;;){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);
    if(!decided&&output.includes("event: approval")){
     assert.equal((await scanCustomExperts(path.join(profile,"expert-config"))).experts.length,0);
     const pending=await api("/approvals");assert.equal(pending[0].name,"expert_package_create");
     await api("/approvals/"+pending[0].id,"POST",{decision:scenario==="deny"?"deny":"approve"});decided=true;
    }
   }
   if(scenario==="unselected"){assert.equal(decided,false);assert.match(output,/Select expert-manager/);}
   const experts=await api("/experts");assert.equal(experts.some(x=>x.id==="custom-expert:creation-proof"),scenario==="create");
   if(scenario==="create"){assert.match(output,/created/);const created=experts.find(x=>x.id==="custom-expert:creation-proof");assert.equal(created.systemPrompt,args.instructions);assert.equal(created.expertType,args.expertType || "agent");if(args.expertType==="team"){assert.equal(created.members.length,2);assert.equal(created.runtimeAvailable,false);}}
  }
 }finally{await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]);}
});

}

test("team creation registers lead, members and individual instruction files without runtime claims",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"wb-create-team-"));
 const team={...args,expertType:"team",members:[{id:"main",name:"主理人",profession:"主编"},{id:"reviewer",name:"复核员",profession:"审稿",instructions:"Only review text."}]};
 for(const members of [[],[{id:"reviewer",name:"复核员",profession:"审稿",instructions:"Review"},{id:"other",name:"其他",profession:"审稿",instructions:"Review"}],[team.members[0],{...team.members[1],id:"../escape"}],[team.members[0],{...team.members[1],id:"main"}],[team.members[0],{...team.members[1],instructions:""}]]) assert.throws(()=>prepareCustomExpert({...team,members}));
 const explicitLead={...team,members:team.members.map(member=>member.id==='main'?{...member,instructions:'Coordinate text review only.'}:member)};
 const explicitFiles=prepareCustomExpert(explicitLead);
 assert.equal(explicitFiles.get('agents/main.md').toString(),'Coordinate text review only.');
 assert.equal(explicitFiles.get('agents/reviewer.md').toString(),'Only review text.');
 for(const instructions of ['',0,'x'.repeat(90001)])assert.throws(()=>prepareCustomExpert({...team,members:team.members.map(member=>member.id==='main'?{...member,instructions}:member)}),/member instructions/);
 await createCustomExpert(root,team);
 const scanned=await scanCustomExperts(root);assert.deepEqual(scanned.errors,[]);
 const expert=scanned.experts[0];assert.equal(expert.expertType,"team");assert.equal(expert.runtimeAvailable,false);assert.equal(expert.teamInfo.leadAgent,"main");assert.equal(expert.members[0].role,"lead");
 assert.equal(await fs.readFile(path.join(expert.expertRootDir,"agents/reviewer.md"),"utf8"),"Only review text.");
 assert.equal(expert.systemPrompt,args.instructions);
 await assert.rejects(createCustomExpert(root,team),/already exists/);
 const {exportCustomExpert,installCustomExpertZip}=await import("../desktop/custom-experts.cjs");
 const exported=await exportCustomExpert(root,expert.id),other=await fs.mkdtemp(path.join(os.tmpdir(),"wb-team-roundtrip-"));
 await installCustomExpertZip(other,exported.zipPath);
 assert.deepEqual((await scanCustomExperts(other)).experts[0].members,expert.members);
});
