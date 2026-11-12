import {apply as applyPocketLayoutCompat} from './pocket-layout-compat.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {createSettingsSearch} from './settings/host.mjs';
import {createFeatureHttpHost} from './settings/http-host.mjs';
import {createDiagnostics} from './diagnostics/host.mjs';
import {createNativeClient} from './native-client/index.mjs';
import {createFeatureSessionRuntime} from './notifications/runtime.mjs';
import {createSessionReaders} from './sessions.mjs';

export const name='dsh-phone-features';
export const inject=['webServer','connection'];
const require=createRequire(import.meta.url),version=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url))).version;
const assets=[['/phone-features/settings/model-catalog-budget.js','settings/model-catalog-budget.js','text/javascript'],['/phone-features','settings/feature-page.html','text/html'],['/phone-features/feature-client.js','settings/feature-client.js','text/javascript'],['/phone-features/feature-style.css','settings/style.css','text/css'],['/phone-features/security.js','settings/security.js','text/javascript'],['/phone-features/bootstrap.js','settings/bootstrap.js','text/javascript'],['/phone-features/notifications/projection.js','notifications/projection.mjs','text/javascript']];
const ordinary=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)&&!value.startsWith('qq-')&&!value.startsWith('cloud-');
const getVersion=module=>{try{return JSON.parse(fs.readFileSync(require.resolve(module+'/package.json'),'utf8')).version;}catch{return null;}};
const nativeFacts=value=>({protocol:value.protocol,foreground:value.foreground,nativeSettingsAvailable:value.nativeSettingsAvailable===true,notifications:{enabled:value.notifications?.enabled===true,doneEnabled:value.notifications?.doneEnabled,attentionEnabled:value.notifications?.attentionEnabled,requiresUiPermission:value.notifications?.requiresUiPermission===true},background:{enabled:value.background?.enabled===true,activeTasks:value.background?.activeTasks,engineRunning:value.background?.engineRunning===true,wakeHeld:value.background?.wakeHeld===true,wakeLeaseMs:value.background?.wakeLeaseMs,batteryExempt:value.background?.batteryExempt,networkBlocked:value.background?.networkBlocked===true,dataSaverStatus:value.background?.dataSaverStatus,vendor:value.background?.vendor},rescue:{selected:value.rescue?.selected===true,suggested:value.rescue?.suggested===true,automaticActivation:false}});

/** Independent Cordis child/profile plugin; no phone-qq ownership, tool or provider changes. */
export async function apply(ctx,options={}){
 const home=options.home??process.env.DSH_HOME??path.join(homedir(),'.dsh'),web=ctx.get('webServer'),http=createFeatureHttpHost(ctx),pages=new Map(),logs=[];let closed=false,runtime=null,webCapabilities=null,nativeState=null,webCapabilityIssue='waiting-credentials';
 ctx.effect(()=>()=>http.close());
 const android=options.android??(process.platform==='android'||process.env.DSH_PHONE_ANDROID==='1'),nativeEnabled=typeof options.nativeCall==='function'||android&&options.role!=='computer';
 const native=options.nativeCall?null:createNativeClient({home,platform:android?'android':process.platform});
 ctx.effect(()=>()=>native?.close());
 const nativeCall=options.nativeCall??((command,payload)=>native.call(command,payload));
 const note=code=>{logs.push({at:new Date().toISOString(),level:'WARN',code});if(logs.length>100)logs.shift();};
 const routeSet=()=>options.availableRoutes?typeof options.availableRoutes==='function'?options.availableRoutes():options.availableRoutes:new Set(web.exact instanceof Map?[...web.exact.keys()]:[]);
 const settings=createSettingsSearch({availableRoutes:routeSet});
 const registerPage=entry=>{const off=settings.register([entry]),token=Symbol(),old=pages.get(entry.id);pages.set(entry.id,{entry,token});return()=>{off();if(pages.get(entry.id)?.token===token){if(old)pages.set(entry.id,old);else pages.delete(entry.id);}};};
 const listedPages=()=>[...pages.values()].map(x=>x.entry).filter(x=>routeSet().has(new URL(x.href,'http://local').pathname));
 const readNative=async()=>{if(!nativeEnabled)return {available:false};try{const value=await nativeCall('status',{});nativeState=value;return {available:true,...value};}catch{nativeState=null;return {available:false};}};
 const diagnostics=createDiagnostics({knownSecrets:options.knownSecrets??[],sources:[
  {name:'runtime',kind:'facts',read:()=>({featurePackage:version,nodeVersion:process.version,platform:process.platform,arch:process.arch,coreSessionVersion:getVersion('@deepseek-ai/dsh-session'),processId:process.pid,uptimeSeconds:Math.floor(process.uptime())})},
  {name:'loaded-services',kind:'facts',read:()=>({webServer:!!ctx.get('webServer'),connection:!!ctx.get('connection'),sessions:!!ctx.get('sessions'),sessionController:!!ctx.get('sessionController'),agents:!!ctx.get('agents'),credentials:!!ctx.get('credentials'),residentSessions:ctx.get('sessions')?.list?.().length??null,residentAgents:ctx.get('agents')?.list?.().length??null,runningAgents:ctx.get('agents')?.list?.().filter(x=>x.status==='running').length??null,features:{settings:true,diagnostics:true,webCapabilities:!!webCapabilities,notifications:!!runtime}})},
  {name:'connection',kind:'facts',read:()=>{const peer=ctx.get('dshPeer');return {peerServicePresent:!!peer,featureHttpPending:http.status().pending,nativeBridgePresent:!!nativeState};}},
  {name:'technical-log',kind:'logs',read:()=>logs},
  ...(nativeEnabled?[{name:'native',kind:'facts',read:async()=>{const value=await readNative();if(!value.available)throw Error('native unavailable');return nativeFacts(value);}}]:[]),
  ...(Array.isArray(options.diagnosticSources)?options.diagnosticSources.slice(0,10):[]),
 ]});
 for(const asset of [...settings.assets,...diagnostics.assets,...assets.map(([assetPath,file,type])=>({path:assetPath,type,bytes:fs.readFileSync(new URL('./'+file,import.meta.url))}))])http.registerAsset(asset);
 registerPage({id:'feature-settings',title:'查找设置',english:'Find settings',group:'增强功能',href:'/phone-features/settings',synonyms:['设置搜索','定位','search']});
 registerPage({id:'feature-diagnostics',title:'手动诊断导出',english:'Diagnostics export',group:'增强功能',href:'/phone-features/diagnostics',synonyms:['ZIP','诊断','错误日志']});
 http.registerGet({path:'/phone-features/settings/search',handler:req=>settings.search(new URL(req.url,'http://local').searchParams.get('q'))});
 http.registerGet({path:'/phone-features/diagnostics/snapshot',handler:()=>diagnostics.snapshot()});
 http.registerApi({path:'/phone-features/diagnostics/prepare',maxBytes:1024,handler:()=>diagnostics.prepare()});
 http.registerDownload({prefix:'/phone-features/diagnostics/download/',handler:(id,{method})=>{const value=diagnostics.takeDownload(id,{consume:method!=='HEAD'});return value?{filename:value.fileName,mime:'application/zip',body:value.bytes}:null;}});
 http.registerGet({path:'/phone-features/native/status',handler:readNative});
 http.registerGet({path:'/phone-features/native-settings',handler:()=>({available:nativeState?.nativeSettingsAvailable===true,message:'请在支持原生增强设置的手机App中，由本人点击打开；此页面不会自动请求权限。'})});
 http.registerGet({path:'/phone-features/status',handler:()=>({package:name,version,nativeAvailable:!!nativeState,notifications:runtime?.status()??{available:false},webCapabilities:webCapabilities?.status?.()??{available:false,reason:webCapabilityIssue},pages:listedPages()})});
 http.registerGet({path:'/phone-features/notifications/status',handler:()=>runtime?.status()??{available:false}});
 http.registerApi({path:'/phone-features/notifications/preferences',maxBytes:4096,handler:value=>{if(!runtime)throw Error();return runtime.configure(value);}});
 http.registerApi({path:'/phone-features/notifications/visibility',maxBytes:2048,handler:value=>{if(runtime){if(value===null||value.clear===true)runtime.visibility(null);else{if(!ordinary(value.sessionId)||Object.keys(value).some(k=>!['sessionId','foreground'].includes(k)))throw Error();runtime.visibility({sessionId:value.sessionId,foreground:value.foreground===true});}}return {accepted:!!runtime};}});
 http.registerApi({path:'/phone-features/notifications/observe',maxBytes:16384,handler:value=>{if(!runtime||!ordinary(value.sessionId)||value.remote!==true||typeof value.source!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.source)||Object.keys(value).some(k=>!['sessionId','source','remote','frame'].includes(k)))throw Error();const frame=value.frame,allowed=frame?.type==='snapshot'?['type','cursor','active']:['type','seq','kind','active','settles','clearAttention'];if(!frame||Object.keys(frame).some(k=>!allowed.includes(k)))throw Error();return runtime.observe(value);}});
 const tap=web.tapIndex(html=>html.replace(/<head(?:\s[^>]*)?>/i,head=>head+'<script src="/phone-features/settings/model-catalog-budget.js"></script>').replace('</head>','<script src="/phone-features/security.js"></script></head>').replace('</body>','<script src="/phone-features/bootstrap.js" defer></script></body>'));
 ctx.effect(()=>tap);
 applyPocketLayoutCompat(ctx);
 if(nativeEnabled){
  let controlCall=options.controlCall;
  if(!controlCall)try{const {NativeControlBridge}=await import('dsh-phone-control/bridge');const bridge=new NativeControlBridge(undefined,{timeout:1500});controlCall=(command,value)=>bridge.call(command,value);}catch{}
  ctx.inject(['sessions','agents','sessionController'],c=>{const current=createFeatureSessionRuntime(c,{nativeCall,home,controlCall,onError:()=>note('ERR_SOCKET_CLOSED')});runtime=current;c.effect(()=>async()=>{await current.close();if(runtime===current)runtime=null;});});
  void readNative();
 }
 ctx.inject(['credentials'],async c=>{try{const {registerWebCapabilities,toWebCapabilityError}=await import('./web-capabilities.mjs');const current=await registerWebCapabilities({ctx:c,sessionReaders:createSessionReaders(c),credentials:c.get('credentials'),storageDir:path.join(home,'storage/phone-features'),assertRequest:http.assertRequest,registerPage,registerApi:entry=>http.registerApi({...entry,handler:async(...args)=>{try{return {ok:true,value:await entry.handler(...args)};}catch(error){return {ok:false,error:toWebCapabilityError(error)};}}}),registerAsset:http.registerAsset,registerDownload:http.registerDownload});if(closed){await current.dispose();return;}webCapabilities=current;webCapabilityIssue=null;c.effect(()=>async()=>{await current.dispose();if(webCapabilities===current)webCapabilities=null;});}catch{webCapabilityIssue='unavailable';note('ERR_INVALID_ARG_VALUE');}});
 const api={version,settings,diagnostics,nativeStatus:readNative,registerPage,get notifications(){return runtime;},get webCapabilities(){return webCapabilities;},status:()=>({closed,pages:listedPages().length,nativeEnabled,sessionObserver:!!runtime,webCapabilities:!!webCapabilities})};
 ctx.provide('dshPhoneFeatures',api);
 ctx.effect(()=>async()=>{if(closed)return;closed=true;await webCapabilities?.dispose?.();await runtime?.close();runtime=null;diagnostics.close();http.close();native?.close();});
 // Cordis treats a non-void apply result as an Effect; the API lives only in the scoped service.
}
