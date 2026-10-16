import {test} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const listen=s=>new Promise(r=>s.listen(0,"127.0.0.1",()=>r(s.address().port)));
function launch(dataDir,port){
 const child=spawn(process.execPath,[path.join(import.meta.dirname,"server-launch.mjs")],{env:{...process.env,WORKBUDDY_DATA_DIR:dataDir,WORKBUDDY_LOCAL_PORT:String(port)},stdio:["ignore","pipe","pipe"]});
 let output="";child.stdout.on("data",c=>output+=c);child.stderr.on("data",c=>output+=c);
 const closed=new Promise(r=>child.once("close",code=>r({code,output})));
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error("Startup timed out "+output));},5000);child.stdout.on("data",()=>{if(output.includes("WORKBUDDY_READY ")){clearTimeout(timer);resolve();}});child.once("close",()=>{clearTimeout(timer);reject(Error(output));});});
 return {child,ready,closed};
}
test("fixed launcher origin is retained across server restart",async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"wb-origin-"));const probe=http.createServer();const port=await listen(probe);await new Promise(r=>probe.close(r));
 for(let round=0;round<2;round++){
  const process=launch(dataDir,port);try{await process.ready;const origin=`http://127.0.0.1:${port}`;
   if(round===0)await fetch(origin+"/api/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"Persistent"})});
   else assert.equal((await (await fetch(origin+"/api/sessions")).json())[0].title,"Persistent");
  }finally{process.child.kill("SIGTERM");await process.closed;}
 }
});
test("occupied fixed port fails explicitly instead of silently changing origin",async()=>{
 const blocker=http.createServer(),port=await listen(blocker),dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"wb-port-"));
 const process=launch(dataDir,port);try{await assert.rejects(process.ready,/already occupied/);const result=await process.closed;assert.equal(result.code,1);assert.doesNotMatch(result.output,/WORKBUDDY_READY/);}finally{process.child.kill();await new Promise(r=>blocker.close(r));}
});
