import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createAppServer } from './app.mjs';
const listen = async (server) => { await new Promise(r=>server.listen(0,'127.0.0.1',r)); return 'http://127.0.0.1:'+server.address().port; };
test('selected skill saves require approval and reject stale or unselected edits', async () => {
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wb-skill-save-'));
 const root=path.join(dataDir,'skills/proof'); await fs.mkdir(root,{recursive:true});
 const filename=path.join(root,'SKILL.md'), before='---\nname: proof\n---\nBefore', after='---\nname: proof\ndisable-model-invocation: true\nuser-invocable: false\n---\nAfter';
 await fs.writeFile(filename,before);
 let callArgs, round=0;
 const model=http.createServer(async(req,res)=>{
  let raw=''; for await(const chunk of req) raw+=chunk;
  const request=JSON.parse(raw);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  let delta;
  if(callArgs.expectedRevision && round===0) delta={tool_calls:[{index:0,id:'read',function:{name:'skill_instructions_read',arguments:JSON.stringify({skillId:callArgs.skillId})}}]};
  else if(callArgs.expectedRevision && round===1){
   const read=JSON.parse(request.messages.at(-1).content);
   assert.equal(read.content,before); assert.equal(read.revision,callArgs.expectedRevision);
   delta={tool_calls:[{index:0,id:'save',function:{name:'skill_instructions_save',arguments:JSON.stringify({...callArgs,expectedRevision:read.revision})}}]};
  } else delta=round===0?{tool_calls:[{index:0,id:'save',function:{name:'skill_instructions_save',arguments:JSON.stringify(callArgs)}}]}:{content:'Finished'};
  round++;
  res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir}),url=await listen(app);
 const api=async(route,method='GET',body)=>{const res=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try {
  await api('/config','PUT',{baseURL:modelUrl+'/v1',model:'fixture'});
  const skill=await api('/skills','POST',{name:'proof',content:before,localRootDir:root});
  for(const scenario of ['deny','stale','unselected','save']) {
   round=0; callArgs={skillId:skill.id,expectedContent:scenario==='stale'?'Wrong':before,content:after};
   if(scenario==='save'){delete callArgs.expectedContent;callArgs.expectedRevision=createHash('sha256').update(before).digest('hex');}
   const session=await api('/sessions','POST',{title:scenario});
   const response=await fetch(url+'/api/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Edit selected skill',mode:'craft',skillIds:scenario==='unselected'?[]:[skill.id]})});
   const reader=response.body.getReader();let output='',approved=false;
   for(;;){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);
    if(!approved&&output.includes('event: approval')){
     assert.equal(await fs.readFile(filename,'utf8'),before);
     const pending=await api('/approvals');assert.equal(pending[0].name,'skill_instructions_save');
     await api('/approvals/'+pending[0].id,'POST',{decision:scenario==='deny'?'deny':'approve'});approved=true;
    }
   }
   assert.equal(await fs.readFile(filename,'utf8'),scenario==='save'?after:before);
   if(scenario==='unselected'){assert.equal(approved,false);assert.match(output,/Select an installed local skill/);}
   if(scenario==='stale')assert.match(output,/changed/);
   if(scenario==='save'){assert.match(output,/saved/);const saved=await api('/skills');const updated=saved.find(x=>x.id===skill.id);assert.equal(updated.content,after);assert.equal(updated.enabled,false);assert.equal(updated.disableModelInvocation,true);assert.equal(updated.userInvocable,false);}
  }
 } finally { await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]); }
});

test('two approved edits of the same skill reject the stale writer', async () => {
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wb-skill-save-race-'));
 const root=path.join(dataDir,'skills/proof'); await fs.mkdir(root,{recursive:true});
 const filename=path.join(root,'SKILL.md'), before='---\nname: proof\n---\nBefore';
 await fs.writeFile(filename,before);let skillId;
 const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw), last=body.messages.at(-1);
  const delta=last.role==='tool'?{content:'Finished'}:{tool_calls:[{index:0,id:'save',function:{name:'skill_instructions_save',arguments:JSON.stringify({skillId,expectedContent:before,content:before+' '+last.content})}}]};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');
 });
 const modelUrl=await listen(model), app=createAppServer({dataDir}), url=await listen(app);
 const api=async(route,method='GET',body)=>{const res=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(res.ok);return res.json();};
 try {
  await api('/config','PUT',{baseURL:modelUrl+'/v1',model:'fixture'});
  skillId=(await api('/skills','POST',{name:'proof',content:before,localRootDir:root})).id;
  const responses=await Promise.all(['A','B'].map(async(message)=>{
   const session=await api('/sessions','POST',{title:message});
   return fetch(url+'/api/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,mode:'craft',skillIds:[skillId]})});
  }));
  const readers=responses.map(response=>response.body.getReader());
  const beginnings=await Promise.all(readers.map(async(reader)=>{let output='';while(!output.includes('event: approval')){const {done,value}=await reader.read();assert(!done);output+=new TextDecoder().decode(value);}return output;}));
  const approvals=await api('/approvals');assert.equal(approvals.length,2);
  await Promise.all(approvals.map(item=>api('/approvals/'+item.id,'POST',{decision:'approve'})));
  const outputs=await Promise.all(readers.map(async(reader,index)=>{let output=beginnings[index];for(;;){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);}return output;}));
  assert.equal(outputs.filter(output=>output.includes('"saved":true')).length,1);
  assert.equal(outputs.filter(output=>output.includes('changed;')).length,1);
  const content=await fs.readFile(filename,'utf8');assert([before+' A',before+' B'].includes(content));
  assert.equal((await api('/skills')).find(skill=>skill.id===skillId).content,content);
 } finally {await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]);}
});

test('skill-creator receives selected target as editable source, not active behavior', async () => {
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wb-skill-edit-context-'));
 const targetContent='---\nname: target\n---\nONLY_REPLY_TARGET_SENTINEL';let system;
 const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  system=JSON.parse(raw).messages.find(x=>x.role==='system').content;
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'Done'}}]})+'\n\ndata: [DONE]\n\n');
 });
 const modelUrl=await listen(model),app=createAppServer({dataDir}),url=await listen(app);
 const api=async(route,method='GET',body)=>{const r=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok);return r.json();};
 try {
  await api('/config','PUT',{baseURL:modelUrl+'/v1',model:'fixture'});
  const creator=await api('/skills','POST',{name:'skill-creator',content:'---\nname: skill-creator\n---\nCREATOR_SENTINEL'});
  const target=await api('/skills','POST',{name:'target',content:targetContent});
  for(const editing of [true,false]) {
   const session=await api('/sessions','POST',{});
   const r=await fetch(url+'/api/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:editing?'Edit target':'Use target',skillIds:editing?[creator.id,target.id]:[target.id]})});await r.text();
   assert.equal(system.includes('ONLY_REPLY_TARGET_SENTINEL'),!editing);
   if(editing){assert.match(system,/CREATOR_SENTINEL/);assert.match(system,/Skill editing reference: target/);assert.match(system,/save the complete SKILL.md/);assert(system.includes(target.id));}
  }
 } finally {await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>model.close(r))]);}
});
