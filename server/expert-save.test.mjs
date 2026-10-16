import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createAppServer } from './app.mjs';
const listen = async (server) => { await new Promise(r=>server.listen(0,'127.0.0.1',r)); return 'http://127.0.0.1:'+server.address().port; };
for (const expertType of ['agent','team']) {
test('expert package saves require manager selection, approval and current content: ' + expertType, async () => {
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'wb-expert-save-')); const dataDir=path.join(profile,'data');
 const root=path.join(profile,'expert-config/plugins/marketplaces/my-experts/plugins/proof'); await fs.mkdir(root,{recursive:true});
 await fs.mkdir(path.join(root,'agents')); await fs.mkdir(path.join(root,'.codebuddy-plugin')); await fs.writeFile(path.join(root,'.codebuddy-plugin/plugin.json'), JSON.stringify(expertType==='team'?{name:'proof',expertType:'team',teamInfo:{leadAgent:'main'},members:[{agent:'main'},{agent_name:'reviewer',id:'market-id'}],displayName:'Proof'}:{name:'proof',agentName:'main',expertType:'agent',displayName:'Proof'})); const target=expertType==='team'?'agents/reviewer.md':'agents/main.md', filename=path.join(root,target), before='Before', after='After';
 if(expertType==='team')await fs.writeFile(path.join(root,'agents/main.md'),'Lead instructions unchanged');
 await fs.writeFile(filename,before);
 let callArgs, round=0;
 const model=http.createServer(async(req,res)=>{
  let requestBody='';
  for await(const chunk of req) requestBody+=chunk;
  const saveTool=JSON.parse(requestBody).tools?.find(tool=>tool.function.name==='expert_package_save');
  if(saveTool)assert(saveTool.function.parameters.required.includes('expectedRevision'), 'Model-facing saves must require the revision returned by the read');
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const delta=round++%2===0?{tool_calls:[{index:0,id:'save',function:{name:'expert_package_save',arguments:JSON.stringify(callArgs)}}]}:{content:'Finished'};
  res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir}),url=await listen(app);
 const api=async(route,method='GET',body)=>{const res=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try {
  await api('/config','PUT',{baseURL:modelUrl+'/v1',model:'fixture'});
  const skill=await api('/skills','POST',{name:'expert-manager',content:'---\nname: expert-manager\n---\nManage experts'});
  for(const scenario of ['deny','stale','unselected','unregistered','save']) {
   round=0; callArgs={path:scenario==='save'?'plugins/marketplaces/my-experts/plugins/proof/'+target:target,expectedContent:scenario==='stale'?'Wrong':before,content:after};
   if(scenario==='unregistered')callArgs.path='agents/unregistered.md';
   if(scenario==='save') { delete callArgs.expectedContent; callArgs.expectedRevision=createHash('sha256').update(before).digest('hex'); }
   const session=await api('/sessions','POST',{title:scenario});
   const response=await fetch(url+'/api/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Edit selected expert',editingExpertId:'custom-expert:proof',mode:'craft',skillIds:scenario==='unselected'?[]:[skill.id]})});
   const reader=response.body.getReader();let output='',approved=false;
   for(;;){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);
    if(!approved&&output.includes('event: approval')){
     assert.equal(await fs.readFile(filename,'utf8'),before);
     const pending=await api('/approvals');assert.equal(pending[0].name,'expert_package_save');
     await api('/approvals/'+pending[0].id,'POST',{decision:scenario==='deny'?'deny':'approve'});approved=true;
    }
   }
   assert.equal(await fs.readFile(filename,'utf8'),scenario==='save'?after:before);
   assert.equal((await api('/sessions/'+session.id)).editingExpertId, scenario==='unselected'?undefined:'custom-expert:proof');
   if(scenario==='unselected'){assert.equal(approved,false);assert.match(output,/Select a local expert/);}
   if(scenario==='stale')assert.match(output,/changed/);
   if(scenario==='unregistered'){assert.equal(approved,false);assert.match(output,/package-relative path/);}
   if(scenario==='save'){assert.match(output,/saved/);const saved=await api('/experts');assert.equal(saved.find(x=>x.id==='custom-expert:proof').systemPrompt,expertType==='team'?'Lead instructions unchanged':after);}
  }
 } finally { await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]); }
});

}

test('team metadata save uses leadAgent and preserves identity, revision and members', async () => {
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'wb-team-save-'));
 const dataDir=path.join(profile,'data'), root=path.join(profile,'expert-config/plugins/marketplaces/my-experts/plugins/proof');
 await fs.mkdir(path.join(root,'.codebuddy-plugin'),{recursive:true}); await fs.mkdir(path.join(root,'agents'));
 const manifest={name:'proof',expertType:'team',teamInfo:{leadAgent:'lead'},displayName:'Team before',members:[{id:'lead',name:'Lead',role:'lead'}]};
 const filename=path.join(root,'.codebuddy-plugin/plugin.json'),before=JSON.stringify(manifest);
 await fs.writeFile(filename,before);await fs.writeFile(path.join(root,'agents/lead.md'),'Coordinate only.');
 let args,round=0;
 const model=http.createServer(async(req,res)=>{
  for await(const chunk of req){}
  const delta=round++%2===0?{tool_calls:[{index:0,id:'save',function:{name:'expert_package_save',arguments:JSON.stringify(args)}}]}:{content:'Finished'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir}),url=await listen(app);
 const api=async(route,method='GET',body)=>{const r=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok);return r.json();};
 try{
  await api('/config','PUT',{baseURL:modelUrl+'/v1',model:'fixture'});
  const skill=await api('/skills','POST',{name:'expert-manager',content:'---\nname: expert-manager\n---\nManage experts'});
  for(const scenario of ['identity','stale','save']){
   round=0;const next={...manifest,displayName:'Team after',...(scenario==='identity'?{teamInfo:{leadAgent:'other'}}:{})};
   args={path:'.codebuddy-plugin/plugin.json',content:JSON.stringify(next),expectedRevision:createHash('sha256').update(scenario==='stale'?'outdated':before).digest('hex')};
   const session=await api('/sessions','POST',{title:scenario});
   const response=await fetch(url+'/api/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Edit team name',editingExpertId:'custom-expert:proof',mode:'craft',skillIds:[skill.id]})});
   let output='',approved=false;
   for await(const value of response.body){output+=new TextDecoder().decode(value);if(!approved&&output.includes('event: approval')){assert.equal(await fs.readFile(filename,'utf8'),before);const pending=await api('/approvals');await api('/approvals/'+pending[0].id,'POST',{decision:'approve'});approved=true;}}
   assert.equal(await fs.readFile(filename,'utf8'),scenario==='save'?JSON.stringify(next):before);
   if(scenario==='identity'){assert.equal(approved,false);assert.match(output,/identity/);}
   if(scenario==='stale')assert.match(output,/changed/);
   if(scenario==='save'){assert.equal(approved,true);const saved=(await api('/experts')).find(x=>x.id==='custom-expert:proof');assert.equal(saved.name,'Team after');assert.deepEqual(saved.members,manifest.members);assert.equal(saved.runtimeAvailable,false);}
  }
 }finally{await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]);}
});
