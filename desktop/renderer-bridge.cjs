"use strict";
let transportSequence = 0;

/** Compatibility surface for the shipped renderer; business results come from local RPC. */
function installRendererBridge({contextBridge, ipcRenderer, webUtils, platform=process.platform, arch=process.arch, configDir="", window:win=globalThis.window, storage=win?.localStorage}={}) {
  if (!contextBridge || !ipcRenderer || !win) throw new Error("Renderer bridge needs Electron contextBridge, ipcRenderer and window");
  const ports = new Map(), listeners = new Map(), eventBridges = new Set();
  const invokeLocal = async (channel, payload) => {
    try { return await ipcRenderer.invoke(channel, payload); }
    catch (error) {
      const message = String(error?.message || error).replace(/^Error invoking remote method 'wb-local:(?:daemon|sdk)': (?:Error: )?/, "");
      const normalized = new Error(message);
      if (error?.code) normalized.code = error.code;
      throw normalized;
    }
  };
  const daemon = async (channel,...args) => {
    if(channel==="file:upload" && Array.isArray(args[0]?.files)) {
      const abortSignal=args[0].abortSignal;
      if(abortSignal?.aborted) return {success:false,aborted:true,urls:[]};
      const files=[];
      for(const file of args[0].files) {
        if(typeof file?.arrayBuffer!=="function" || file.size>100000) throw new Error("本地附件目前支持小于100000字节的文本文件。");
        files.push({name:file.name,type:file.type,data:new Uint8Array(await file.arrayBuffer())});
      }
      if(abortSignal?.aborted) return {success:false,aborted:true,urls:[]};
      args=[{files}];
    }
    return invokeLocal("wb-local:daemon",{channel,args});
  };
  const sdk = (channel,context,...args) => invokeLocal("wb-local:sdk",{channel,context,args});
  const expose = (name,value) => contextBridge.exposeInMainWorld(name,value);
  const on = (channel,callback) => {
    if (typeof callback!=="function") throw new TypeError("Event callback must be a function");
    if (!listeners.has(channel)) listeners.set(channel,new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  };
  const off = (channel,callback) => listeners.get(channel)?.delete(callback);
  const publish = (_event,envelope) => {
    if (!envelope || envelope.type!=="event" || typeof envelope.channel!=="string") return;
    for (const callback of listeners.get(envelope.channel)||[]) callback(envelope.result);
    for (const callback of eventBridges) callback(envelope.channel,envelope.result);
    for (const [port,sessionId] of ports) port.postMessage({kind:"message",sessionId,json:envelope});
  };
  ipcRenderer.on("wb-local:event",publish);
  const receivePort = (event) => {
    if (event.source!==win || event.data?.type!=="workbuddy:open-local-daemon-transport-port") return;
    const port=event.ports?.[0]; if(!port) return;
    const sessionId=`local-port-${Date.now()}-${++transportSequence}`; ports.set(port,sessionId);
    port.onmessage=async ({data})=>{
      if(data?.kind==="close"){ports.delete(port);port.close();return;}
      if(data?.kind!=="message") return;
      let request;
      try {
        request=data.json??JSON.parse(data.text);
        if(request.type==="handshake") {
          port.postMessage({kind:"message",sessionId,json:{id:request.id,type:"handshake_ack"}});return;
        }
        if(request.type!=="request" || typeof request.channel!=="string" || !Array.isArray(request.args)) throw new Error("Invalid daemon request envelope");
        const result=await daemon(request.channel,...request.args);
        if(ports.has(port)) port.postMessage({kind:"message",sessionId,json:{id:request.id,type:"response",result}});
      } catch(error) {
        if(ports.has(port)) port.postMessage({kind:"message",sessionId,json:{id:request?.id,type:"error",error:{message:error.message,code:error.code||"LOCAL_RPC_ERROR"}}});
      }
    };
    port.onmessageerror=()=>{ports.delete(port);port.close();};
    port.start();port.postMessage({kind:"open",sessionId});
  };
  win.addEventListener("message",receivePort);
  const native=(channel,...args)=>daemon(channel,...args);
  const currentWindow={
    minimize:()=>native("workbuddy:window:minimize"),maximize:()=>native("workbuddy:window:maximize"),close:()=>native("workbuddy:window:close"),
    isMaximized:()=>native("workbuddy:window:isMaximized"),isFullscreen:()=>native("workbuddy:window:isFullscreen"),
    setFullscreen:flag=>native("workbuddy:window:setFullscreen",flag),toggleFullscreen:()=>native("workbuddy:window:toggleFullscreen"),
    openStartupAnalysis:()=>native("workbuddy:window:openStartupAnalysis"),startDrag:()=>native("workbuddy:window:startDrag"),stopDrag:()=>native("workbuddy:window:stopDrag"),
    onMaximizeChange:cb=>on("window:maximizeChanged",cb),onFocusChange:cb=>on("window:focusChanged",cb),onFullscreenChange:cb=>on("window-fullscreen-changed",cb)
  };
  const desktop={platform,appVersion:"local",configDir,machineId:()=>native("workbuddy:machineId"),
    app:{getBootstrapInfo:async()=>({}),consumePendingOpenUrls:()=>native("app:consumePendingOpenUrls")},
    invoke:(command,args)=>native(command,args),events:{on},window:{getCurrentWindow:()=>currentWindow},
    opener:{openUrl:url=>native("workbuddy:opener:openUrl",url)},localFile:{open:options=>native("workbuddy:localFile:open",options)},
    dialog:{open:options=>native("workbuddy:dialog:open",options),saveImage:(dataUrl,name)=>native("dialog:saveImage",dataUrl,name)},
    clipboard:{readText:()=>native("workbuddy:clipboard:readText"),writeText:text=>native("workbuddy:clipboard:writeText",text),writeImage:data=>native("workbuddy:clipboard:writeImage",data)},
    notification:{isSupported:()=>native("workbuddy:notification:isSupported"),requestRegistration:()=>native("workbuddy:notification:requestRegistration"),sendNotification:payload=>native("workbuddy:notification:send",payload)},
    globalShortcut:{updateToggleWindow:value=>native("workbuddy:globalShortcut:updateToggleWindow",value),onRegistrationStatus:cb=>on("globalShortcut:registrationStatus",cb)},
    chooseWorkspace:()=>native("window:selectDirectory"),openExternal:url=>native("workbuddy:opener:openUrl",url),download:url=>native("desktop:download",url),
    minimize:currentWindow.minimize,toggleMaximize:currentWindow.maximize,close:currentWindow.close,info:()=>native("desktop:info")
  };
  expose("workbuddyDesktop",desktop);
  expose("vscode",{webUtils:{getPathForFile:file=>{if(!webUtils?.getPathForFile)throw new Error("Native File path resolution unavailable");return webUtils.getPathForFile(file);}},
    postMessage:message=>native("vscode:postMessage",message),getState:()=>{const raw=storage?.getItem("wb-local:vscode-state");return raw?JSON.parse(raw):undefined;},setState:value=>{if(!storage)throw new Error("Local renderer storage unavailable");storage.setItem("wb-local:vscode-state",JSON.stringify(value));return value;}});
  expose("__hostPlatform",{platform,arch,hostArch:arch});expose("__hostPlatformProbe",{resolvedBy:"independent-local-host",resolvedHostArch:arch});
  expose("__isLoggedIn",true); // Local identity only; daemon auth RPC must provide the matching independent profile.
  expose("__wbInvoke",sdk);expose("__wbOn",on);expose("__wbOff",off);
  expose("__wbEventBridge",callback=>{eventBridges.add(callback);return()=>eventBridges.delete(callback);});
  expose("__workbuddyStartupPerfD",{drain:()=>[]});
  const routed={
    __workbuddyStartDragLocalFile:"workbuddy:localFile:startDrag",
    __workbuddyRegisterOnlineDocPreview:"workbuddy:registerOnlineDocPreview",__workbuddyUnregisterOnlineDocPreview:"workbuddy:unregisterOnlineDocPreview",__workbuddyUpdateDocsFeatureList:"workbuddy:updateDocsFeatureList",
    __setShortcutRecordingState:"shortcut:set-recording-state",__debugCrashTest:"debug:crashTest",__openTencentDocsDebugPanel:"debug:openTencentDocsPanel",__openStartupAnalysis:"workbuddy:window:openStartupAnalysis",__getStartupTraceid:"workbuddy:window:getStartupTraceId",
    __getTdocImportPreloadUrl:"tdoc-import:get-preload-url",__getTdocPreviewPreloadUrl:"tdoc-preview:get-preload-url",__getHostWebviewPreloadUrl:"workbuddy:tencentDocs:getWebviewPreloadUrl",
    __setTencentDocsLanguage:"workbuddy:tencentDocs:setLanguage",__setTencentDocsTheme:"workbuddy:tencentDocs:setTheme",__getClientMenuPreloadUrl:"client-menu:get-preload-url",
    __consumeTencentDocsRendererEvents:"tencent-docs:consume-pending-renderer-events",__reportRendererJsError:"crash:renderer-js-error",__signalStartupFirstPaint:"renderer:signalStartupFirstPaint"
  };
  for(const [name,channel]of Object.entries(routed))expose(name,(...args)=>native(channel,...args));
  // No integration with the original WeChat install: truthfully unavailable in this independent host.
  expose("__checkWechatInstalled__",()=>false);expose("__getWechatVersion__",()=>null);
  expose("__workbuddyDevtoolsTerminal",{attach:sessionId=>daemon("devtools-terminal:attach",{sessionId}),poll:subscriptionId=>daemon("devtools-terminal:poll",subscriptionId),input:(subscriptionId,data)=>daemon("devtools-terminal:input",{subscriptionId,data}),resize:(sessionId,cols,rows)=>daemon("sidecar:resize",sessionId,cols,rows),detach:subscriptionId=>daemon("devtools-terminal:detach",{subscriptionId})});
  const cleanup=()=>{win.removeEventListener("message",receivePort);ipcRenderer.removeListener("wb-local:event",publish);for(const port of ports.keys())port.close();ports.clear();listeners.clear();eventBridges.clear();};
  win.addEventListener("unload",cleanup,{once:true});
  return {daemon,sdk,cleanup};
}
module.exports={installRendererBridge};
