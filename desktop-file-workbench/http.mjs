import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const FILE_LIMITS=Object.freeze({maxTextBytes:2*1024*1024,maxImportBytes:64*1024*1024,maxImportConcurrent:2,maxRequests:8});
const ACTIONS=new Set(['roots.list','roots.planAdd','roots.add','roots.remove','list','read','write','mkdir','rename','search','export.prepare']);
const failure=(code,message,status=400)=>Object.assign(new Error(message),{code,status,expose:true});
const loopback=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
function requestOrigin(req){
 if(typeof req.headers.host!=='string'||/[\s/@\\]/.test(req.headers.host))throw failure('forbidden','请从电脑本机的 DSH 打开文件工作台',403);
 let value;try{value=new URL('http://'+req.headers.host);}catch{throw failure('forbidden','请求来源无效',403);}
 if(!['127.0.0.1','localhost','[::1]'].includes(value.hostname)||!loopback(req.socket?.remoteAddress))throw failure('forbidden','请从电脑本机的 DSH 打开文件工作台',403);
 return value.origin;
}
function equalToken(a,b){if(typeof a!=='string'||a.length>128)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function errorDto(error){
 if(error?.expose===true&&typeof error.code==='string'&&/^[A-Za-z0-9_./-]{1,90}$/.test(error.code))return {status:[400,401,403,404,405,408,409,410,413,415,422,429,503].includes(error.status)?error.status:400,body:{ok:false,error:{code:error.code,message:String(error.message||'文件操作未完成').slice(0,300)}}};
 const known={ENOENT:['not-found','文件或目录已不存在',404],EACCES:['permission','当前目录没有访问权限',403],EPERM:['permission','当前目录没有访问权限',403],EEXIST:['conflict','目标已存在，原文件已保留',409],ENOSPC:['no-space','磁盘空间不足，原文件已保留',503],AbortError:['cancelled','操作已取消',408]};
 const value=known[error?.code]||known[error?.name];if(value)return {status:value[2],body:{ok:false,error:{code:value[0],message:value[1]}}};
 return {status:503,body:{ok:false,error:{code:'unavailable',message:'文件操作暂时不可用，请重试'}}};
}
function send(res,status,body,type='application/json; charset=utf-8'){
 if(res.destroyed||res.writableEnded)return;
 if(res.headersSent){res.destroy();return;}
 res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
}
async function jsonBody(req,signal,maxBytes){
 const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw failure('too-large','请求内容过大',413);
 const bytes=await new Promise((resolve,reject)=>{
  const parts=[];let size=0;
  const cleanup=()=>{req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',error);signal.removeEventListener('abort',abort);};
  const error=value=>{cleanup();req.pause();reject(value);};
  const abort=()=>error(signal.reason);
  const data=chunk=>{size+=chunk.length;if(size>maxBytes){error(failure('too-large','请求内容过大',413));return;}parts.push(chunk);};
  const end=()=>{cleanup();resolve(Buffer.concat(parts));};
  if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});req.on('data',data);req.once('end',end);req.once('error',error);
 });
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw failure('invalid-request','请求内容无法读取');}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>['__proto__','constructor','prototype'].includes(k)))throw failure('invalid-request','请求内容无效');return value;
}

const disposition=name=>{
 const clean=String(name||'file').replace(/[\x00-\x1f\x7f"\\/]/g,'_');return 'attachment; filename="file"; filename*=UTF-8\'\''+encodeURIComponent(clean);
};

/** One authenticated UI-only route owner. No model tool or session policy changes. */
export function createFileWorkbenchHttp({connection,service,assets=new Map(),limits=FILE_LIMITS,deadlineMs=30000,importDeadlineMs=120000}){
 const csrf=randomBytes(32).toString('base64url'),controllers=new Set();let closed=false,imports=0;
 const check=(req,mutation=false)=>{
  if(closed)throw failure('closed','文件工作台已关闭，请重新打开',410);
  const origin=requestOrigin(req),rejection=connection.requestRejection(req);
  if(rejection)throw failure('unauthorized','请在已登录的 DSH 中打开文件工作台',rejection===401?401:403);
  const site=req.headers['sec-fetch-site'];if(site&&site!=='same-origin'&&site!=='none')throw failure('forbidden','请求来源无效',403);
  if(req.headers.origin&&req.headers.origin!==origin)throw failure('forbidden','请求来源无效',403);
  if(mutation&&(req.headers.origin!==origin||!equalToken(req.headers['x-dsh-files-csrf'],csrf)))throw failure('forbidden','页面已过期，请重新打开文件工作台',403);
  return origin;
 };
 async function handle(req,res){
  let controller,timer,aborted,closeResponse,meter;
  try{
   const origin=check(req),url=new URL(req.url,origin);if(url.origin!==origin)throw failure('forbidden','请求来源无效',403);
   const asset=assets.get(url.pathname);
   if(asset){if(!['GET','HEAD'].includes(req.method))throw failure('method','此操作不支持该请求方式',405);if(url.search)throw failure('invalid-request','页面地址无效');res.writeHead(200,{'content-type':asset.type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",'referrer-policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:asset.bytes);return;}
   if(controllers.size>=limits.maxRequests)throw failure('busy','文件操作较多，请稍后重试',429);
   controller=new AbortController();controllers.add(controller);aborted=()=>controller.abort(failure('cancelled','操作已取消',408));closeResponse=()=>{if(!res.writableFinished)aborted();};req.once('aborted',aborted);res.once('close',closeResponse);timer=setTimeout(()=>{controller.abort(failure('timeout','操作超时，请稍后重试',408));meter?.destroy(controller.signal.reason);send(res,408,{ok:false,error:{code:'timeout',message:'操作超时，请稍后重试'}});},url.pathname==='/desktop-files/api/import'?importDeadlineMs:deadlineMs);timer.unref?.();
   if(url.pathname==='/desktop-files/api/bootstrap'){
    if(req.method!=='GET'||url.search)throw failure('method','页面初始化请求无效',405);
    const value=await service.manage('roots.list',{}, {signal:controller.signal});send(res,200,{ok:true,value:{csrf,roots:value.roots,limits:{...limits,...service.limits,...value.limits}}});return;
   }
   if(url.pathname==='/desktop-files/api/manage'){
    if(req.method!=='POST')throw failure('method','此操作需要明确提交',405);check(req,true);
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type']||'')))throw failure('content-type','请求格式无效',415);
    const {action,...payload}=await jsonBody(req,controller.signal,4*1024*1024+65536);
    if(!ACTIONS.has(action))throw failure('invalid-action','不支持此文件操作');
    const value=await service.manage(action,payload,{signal:controller.signal});if(controller.signal.aborted)throw controller.signal.reason;send(res,200,{ok:true,value});return;
   }
   if(url.pathname==='/desktop-files/api/import'){
    if(req.method!=='POST')throw failure('method','请选择要导入的文件',405);check(req,true);
    if(req.headers['content-type']!=='application/octet-stream')throw failure('content-type','导入文件格式无效',415);
    if(imports>=limits.maxImportConcurrent)throw failure('busy','正在导入其他文件，请稍后重试',429);
    if(req.headers['content-length']!==undefined&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>limits.maxImportBytes))throw failure('too-large','单个导入文件最多64 MiB',413);
    for(const name of url.searchParams.keys())if(!['rootId','generation','path'].includes(name)||url.searchParams.getAll(name).length!==1)throw failure('invalid-request','导入目标无效');
    let name;try{name=decodeURIComponent(String(req.headers['x-dsh-file-name']||''));}catch{throw failure('invalid-name','文件名无法读取');}if(!name||name.length>1024)throw failure('invalid-name','请选择有效的文件');
    let bytes=0;meter=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>limits.maxImportBytes?failure('too-large','单个导入文件最多64 MiB',413):null,chunk);}});meter.on('error',()=>{});
    const onAbort=()=>meter.destroy(controller.signal.reason);controller.signal.addEventListener('abort',onAbort,{once:true});imports++;req.pipe(meter);
    try{const value=await service.importFile({rootId:url.searchParams.get('rootId'),generation:url.searchParams.get('generation'),path:url.searchParams.get('path')||'',name,stream:meter,signal:controller.signal});if(controller.signal.aborted)throw controller.signal.reason;send(res,200,{ok:true,value});}
    finally{imports--;req.unpipe(meter);controller.signal.removeEventListener('abort',onAbort);meter.destroy();if(!req.complete)req.resume();}return;
   }
   const download=url.pathname.match(/^\/desktop-files\/export\/([A-Za-z0-9_-]{16,128})$/);
   if(download){if(!['GET','HEAD'].includes(req.method)||url.search||req.headers.range)throw failure('invalid-download','下载请求无效',400);
    const file=await service.takeExport(download[1],{consume:req.method==='GET',signal:controller.signal});if(!file)throw failure('expired','下载已过期，请重新选择文件',410);
    if(!Number.isSafeInteger(file.size)||file.size<0)throw failure('unavailable','暂时无法下载此文件',503);
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':file.size,'content-disposition':disposition(file.filename),'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
    if(req.method==='HEAD'){file.stream?.destroy?.();res.end();return;}if(!file.stream)throw failure('unavailable','暂时无法下载此文件',503);await pipeline(file.stream,res,{signal:controller.signal});return;
   }
   throw failure('not-found','找不到此文件工作台页面',404);
  }catch(error){if(!res.destroyed){const value=errorDto(controller?.signal.aborted?controller.signal.reason:error);send(res,value.status,value.body);}}
  finally{clearTimeout(timer);if(controller)controllers.delete(controller);if(aborted)req.removeListener('aborted',aborted);if(closeResponse)res.removeListener('close',closeResponse);if(!req.complete){req.resume();const drainTimer=setTimeout(()=>req.destroy(),1000);drainTimer.unref?.();req.once('end',()=>clearTimeout(drainTimer));req.once('close',()=>clearTimeout(drainTimer));}}
 }
 return {handle,status:()=>({closed,pending:controllers.size,imports}),close(){if(closed)return;closed=true;for(const controller of controllers)controller.abort(failure('closed','文件工作台已关闭',410));controllers.clear();}};
}
