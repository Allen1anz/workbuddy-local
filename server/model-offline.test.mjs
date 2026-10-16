import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createAppServer} from './app.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('stopped model produces an actionable streamed error and never fabricates an answer',async()=>{
 const reserved=http.createServer();const unusedPort=await listen(reserved);await new Promise(r=>reserved.close(r));
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wb-offline-model-'));const app=createAppServer({dataDir});const port=await listen(app),base='http://127.0.0.1:'+port+'/api';
 const api=async(route,method,body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(response.ok);return response.json();};
 try {
  await api('/config','PUT',{baseURL:'http://127.0.0.1:'+unusedPort+'/v1',model:'paused-model'});
  const session=await api('/sessions','POST',{title:'Offline model verification'});
  const response=await fetch(base+'/sessions/'+session.id+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'test'})});
  const output=await response.text();assert.match(output,/event: error/);assert.match(output,/模型可能尚未启动或已暂停/);assert(!output.includes('fetch failed'));assert(!output.includes('event: done'));
  const messages=await (await fetch(base+'/sessions/'+session.id+'/messages')).json();assert(!messages.some(x=>x.role==='assistant'));
 }finally{await new Promise(r=>app.close(r));}
});
