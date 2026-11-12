import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createConversationFeatures} from './conversation/host.mjs';
import {createContributionRegistry,CONTRIBUTION_SLOTS} from './declarative/host.mjs';
import {createSshHosts} from './ssh/host.mjs';

const prefix='/phone-features';
const assetDefinitions={conversation:['page.html','page.css','client.js','model.mjs'],declarative:['page.html','page.css','client.js','renderer.mjs','host-adapter.mjs','surface.css'],ssh:['index.html','client.js','page.css']};
const assert=(value,message)=>{if(!value)throw Error(message);};
const referencePattern=/^dsh-ssh\/[a-f0-9]{24}\/(?:password|privateKey|passphrase|webToken)\/[a-f0-9]{24}$/;
const publicCodes=Object.freeze({AUTH_FAILED:'SSH认证失败，请检查密码或密钥。',INVALID_AUTH_SECRET:'私钥或密钥口令无效。',CREDENTIAL_MISSING:'保存的SSH凭据不可用，请重新填写。',STALE_REVISION:'主机配置已变化，请刷新后重试。',STORAGE_CHANGED:'主机配置已由其他操作更新，请重新打开。',STORAGE_BUSY:'主机配置正在保存，请稍后重试。',STORAGE_WRITE_FAILED:'主机配置未能保存，原配置仍保留。',STORAGE_UNAVAILABLE:'主机配置暂不可读取。',CREDENTIAL_SAVE_FAILED:'凭据未能保存，请重试。',CANCELLED:'操作已取消。',OPERATION_BUSY:'此主机已有操作正在进行。',HOST_NOT_FOUND:'主机配置已删除，请刷新。',SSH_CONNECTION_FAILED:'SSH连接失败，请检查地址和网络。',SSH_CONNECTION_CLOSED:'SSH连接已断开。',TRUST_PROPOSAL_EXPIRED:'首次指纹确认已过期，请重新测试。',ALREADY_TRUSTED:'主机已有固定指纹，请刷新。'});
const publicMessages=new Set(['会话已变化，请刷新后重新选择','消息选择已变化','范围选择已失效','所选消息没有可导出的内容','请至少选择一种内容','导出文件过大，请缩小范围','导出超过 8 MiB，请缩小范围','图片内容太长，请减少所选消息','待下载文件过多，请完成下载后再试','回放文件最多 8 MiB','回放文件不是有效 JSON','不支持的回放格式或版本','回放包含不支持的字段','仅支持脱敏回放格式','回放没有消息','当前核心尚无只读会话接口','当前核心尚无安全的会话投影接口','当前环境尚未加载会话服务','仅支持普通本机会话','插件界面已变化，请刷新后重试','按钮或输入框已失效','插件暂未准备好','插件操作正在进行，请稍候','插件操作已取消','插件操作超时','插件操作未完成','请从会话中的消息操作打开；当前页面没有消息范围。']);
/** Parent HTTP adapters may expose only these messages, never a reader/plugin exception or stack. */
export function toWebCapabilityError(error){const code=typeof error?.code==='string'&&Object.hasOwn(publicCodes,error.code)?error.code:null,message=code?publicCodes[code]:publicMessages.has(error?.message)?error.message:null;return {code:message?(code??'WEB_VALIDATION_FAILED'):'WEB_CAPABILITY_FAILED',message:message??'操作未完成，请刷新后重试。'};}

/** Adapt the SDK's POSIX CredentialRef API without putting secret strings in settings or host files. */
export function createSdkCredentialStore(provider){
 assert(provider&&['resolve','set','unset'].every(name=>typeof provider[name]==='function'),'当前凭据库缺少 resolve/set/unset 接口');
 const key=ref=>{assert(referencePattern.test(ref),'SSH凭据引用不属于本模块');return 'DSH_PHONE_FEATURES_SSH_'+createHash('sha256').update(ref).digest('hex').toUpperCase();};
 return {get:async ref=>(await provider.resolve(key(ref)))?.value,set:(ref,value)=>provider.set(key(ref),value),remove:ref=>provider.unset(key(ref))};
}

function createUiService(ctx,registry){
 const owners=new Map();let closed=false;
 const service={
  version:1,slots:CONTRIBUTION_SLOTS,
  scope(pluginCtx,owner){
   assert(!closed,'插件界面服务已关闭');assert(typeof pluginCtx?.effect==='function','插件必须提供自身生命周期');
   const old=owners.get(owner);if(old){assert(old.ctx===pluginCtx,'插件界面包名已由其他生命周期持有');return old.api;}
   const handles=new Map();let dead=false;
   const dispose=()=>{if(dead)return;dead=true;for(const h of handles.values())h.dispose();handles.clear();if(owners.get(owner)?.api===api)owners.delete(owner);};
   const api={register(contribution,handler){assert(!dead&&!closed,'插件界面作用域已关闭');const handle=registry.register(owner,contribution,handler);handles.set(handle.id,handle);return {revision:handle.revision,id:handle.id,dispose(){handle.dispose();if(handles.get(handle.id)===handle)handles.delete(handle.id);}};},dispose};
   // Registration validates the owner even when the plugin has not added a first view yet.
   assert(typeof owner==='string'&&/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,100}$/.test(owner),'插件包名无效');
   owners.set(owner,{ctx:pluginCtx,api});pluginCtx.effect(()=>dispose);return api;
  },
  register(owner,contribution,handler,{scope=ctx}={}){return service.scope(scope,owner).register(contribution,handler);},
  removeOwner(owner,{scope=ctx}={}){const entry=owners.get(owner);if(entry){assert(entry.ctx===scope,'不能撤销其他插件的界面');entry.api.dispose();}},
  status(){return {version:1,slots:[...CONTRIBUTION_SLOTS],owners:owners.size,contributions:closed?0:registry.list().items.length};},
  dispose(){if(closed)return;closed=true;for(const row of [...owners.values()])row.api.dispose();registry.dispose();},
 };
 return service;
}

/** Product route adapter: the parent keeps SDK authentication, Origin/CSRF and raw HTTP parsing. */
export async function registerWebCapabilities({ctx,sessionReaders,credentials,storageDir,assertRequest,registerPage,registerApi,registerAsset,registerDownload}={}){
 assert(sessionReaders&&['listSessions','readSession'].every(name=>typeof sessionReaders[name]==='function'),'缺少真实只读会话读取器');
 assert(typeof storageDir==='string'&&path.isAbsolute(storageDir),'缺少私有功能存储目录');
 for(const [name,fn]of Object.entries({assertRequest,registerPage,registerApi,registerAsset,registerDownload}))assert(typeof fn==='function','缺少宿主接口 '+name);
 const provider=credentials??ctx?.get?.('credentials')??ctx?.credentials;
 const credentialStore=provider&&['get','set','remove'].every(name=>typeof provider[name]==='function')?provider:createSdkCredentialStore(provider);
 const conversation=createConversationFeatures(sessionReaders),registry=createContributionRegistry({onChange:event=>{try{ctx?.emit?.('dsh-phone-features/ui-changed',event);}catch{}}});
 const ssh=createSshHosts({storageFile:path.join(storageDir,'ssh-hosts.json'),credentials:credentialStore});
 await ssh.ready;
 const uiService=createUiService(ctx,registry),disposers=[];let disposed=false;
 const collect=value=>{if(typeof value==='function')disposers.push(value);else if(value&&typeof value.dispose==='function')disposers.push(()=>value.dispose());};
 const check=async(context,mutation)=>{assert(!disposed,'功能服务已关闭');assert(context?.req,'缺少原始请求身份上下文');assert(await assertRequest(context.req,{mutation})===true,'请求身份或来源无效');};
 const pages=[
  {id:'offline-conversation',title:'会话分享与离线回放',english:'Conversation sharing and replay',group:'会话',href:prefix+'/conversation/',synonyms:['分享','导出','回放','Markdown','HTML','JSON','SVG']},
  {id:'declarative-plugin-ui',title:'插件声明式界面',english:'Declarative plugin UI',group:'插件',href:prefix+'/declarative/',synonyms:['插件卡片','输入胶囊','状态条','面板']},
  {id:'ssh-hosts',title:'SSH 远程主机',english:'SSH hosts',group:'连接',href:prefix+'/ssh/',synonyms:['SSH','主机','指纹','端口转发']},
 ];
 const assets=[];
 for(const [scope,names]of Object.entries(assetDefinitions))for(const name of names){const bytes=await fs.readFile(new URL(`./${scope}/${name}`,import.meta.url)),type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript';assets.push({path:`${prefix}/${scope}/${name}`,type,bytes});}
 for(const page of pages){const scope=page.href.split('/').filter(Boolean).at(-1),source=assets.find(a=>a.path===`${prefix}/${scope}/${scope==='ssh'?'index.html':'page.html'}`);assets.push({...source,path:page.href});}
 const apiPaths=[prefix+'/conversation/manage',prefix+'/declarative/manage',prefix+'/ssh/manage'];
 try{
  for(const item of assets)collect(await registerAsset(item));
  for(const page of pages)collect(await registerPage(page));
  for(const [route,service]of [[apiPaths[0],conversation],[apiPaths[1],registry],[apiPaths[2],ssh]])collect(await registerApi({path:route,method:'POST',handler:async(payload,context)=>{await check(context,true);return service.manage(payload,{signal:context.signal});}}));
  collect(await registerDownload({prefix:prefix+'/conversation/download/',handler:async(token,context)=>{await check(context,false);assert(['GET','HEAD'].includes(context.method??context.req.method),'下载方法无效');assert(typeof token==='string'&&/^[0-9a-f-]{36}$/i.test(token),'下载编号无效');return conversation.download(token);}}));
  if(ctx?.provide){assert(!ctx.get?.('dshPhoneFeatureUi'),'插件界面宿主已存在');ctx.provide('dshPhoneFeatureUi',uiService);}
  // The five slots remain available to scoped host plugins. Navigation lives in
  // the SDK session menu/settings; no default cards occupy chat or composer seats.
 }catch(error){for(const stop of disposers.reverse())try{await stop();}catch{}uiService.dispose();conversation.dispose();await ssh.dispose();throw error;}
 async function dispose(){if(disposed)return;disposed=true;for(const stop of disposers.reverse())try{await stop();}catch{}uiService.dispose();conversation.dispose();await ssh.dispose();}
 ctx?.effect?.(()=>dispose);
 return {dispose,uiService,assets,apiPaths,pageEntries:pages,status:()=>({disposed,conversation:'read-only',declarative:uiService.status(),ssh:'explicit-user-connection',nativeRequired:false,productionReader:true})};
}
