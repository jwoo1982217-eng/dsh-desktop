import {randomBytes,timingSafeEqual} from 'node:crypto';
const contentType='application/json; charset=utf-8';
export class FeatureHttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export const jsonReply=(res,status,value)=>{res.writeHead(status,{'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(value));};
function body(req,limit){return new Promise((resolve,reject)=>{let done=false,size=0;const parts=[],finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',failed);if(error){req.resume();reject(error);}else resolve(value);},data=part=>{size+=part.length;if(size>limit)return finish(new FeatureHttpError(413,'请求内容过大'));parts.push(part);},end=()=>{try{const parsed=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();finish(null,parsed);}catch{finish(new FeatureHttpError(400,'请求格式无效'));}},failed=()=>finish(new FeatureHttpError(400,'请求未接收完成')),timer=setTimeout(()=>finish(new FeatureHttpError(408,'请求接收超时')),10000);timer.unref?.();req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',failed);});}
export function createFeatureHttpHost(ctx,{maxRequests=4}={}){
 const csrf=randomBytes(32).toString('hex'),disposers=[];let pending=0,closed=false;
 const own=disposer=>{if(typeof disposer!=='function')return;let active=true;const off=()=>{if(!active)return;active=false;return disposer();};disposers.push(off);return off;};
 const assertRequest=(req,{mutation=false}={})=>{
  if(closed)throw new FeatureHttpError(503,'增强功能已停止');
  const rejection=ctx.get('connection')?.requestRejection?.(req);if(rejection!==undefined||typeof ctx.get('connection')?.requestRejection!=='function')throw new FeatureHttpError(rejection??401,'请先在已登录的DSH中打开');
  const host=String(req.headers.host??'');if(!host||host.length>255||!/^\[?[A-Za-z0-9:.\]-]+$/.test(host))throw new FeatureHttpError(403,'请求主机无效');
  const protocol=ctx.get('webServer')?.protocol==='https:'?'https:':'http:',origin=protocol+'//'+host;
  if(req.headers.origin!==undefined&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')throw new FeatureHttpError(403,'请求来源无效');
  if(mutation){const token=String(req.headers['x-dsh-phone-features-csrf']??'');if(req.headers.origin!==origin||!req.headers['content-type']?.toLowerCase().startsWith('application/json')||token.length!==csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(csrf)))throw new FeatureHttpError(403,'请从当前增强功能页面重新操作');}
  return true;
 };
 const wrap=(handler,{mutation=false,methods=['GET','HEAD']}={})=>async(req,res)=>{try{assertRequest(req,{mutation});if(!methods.includes(req.method))throw new FeatureHttpError(405,'请求方法无效');await handler(req,res);}catch(error){req.resume();if(!res.headersSent&&!res.destroyed)jsonReply(res,error instanceof FeatureHttpError?error.status:400,{ok:false,error:error instanceof FeatureHttpError?error.message:'操作未完成，请刷新后重试'});}};
 const register=route=>own(ctx.get('webServer').register(route));
 const registerAsset=asset=>register({kind:'exact',path:asset.path,handler:wrap((req,res)=>{
  let bytes=asset.bytes;if(asset.type.startsWith('text/html'))bytes=Buffer.from(String(bytes).replace(/<head(?:\s[^>]*)?>/i,head=>head+'<script src="/phone-features/security.js"></script>'));
  res.writeHead(200,{'content-type':asset.type+'; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"});res.end(req.method==='HEAD'?undefined:bytes);
 })});
 const registerApi=({path,method='POST',handler,maxBytes=20*1024*1024})=>register({kind:'exact',path,handler:wrap(async(req,res)=>{
  if(pending>=maxRequests)throw new FeatureHttpError(429,'其他增强功能操作正在进行');pending++;const controller=new AbortController();const abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
  try{const payload=await body(req,maxBytes),value=await handler(payload,{req,signal:controller.signal});if(!res.destroyed)jsonReply(res,200,value);}finally{pending--;req.removeListener('aborted',abort);res.removeListener('close',abort);}
 },{mutation:true,methods:[method]})});
 const registerGet=({path,handler,kind='exact'})=>register({kind,path,handler:wrap(async(req,res)=>{const value=await handler(req,res);if(!res.headersSent&&!res.destroyed)jsonReply(res,200,value);})});
 const registerDownload=({prefix,handler})=>{const routePrefix=prefix.replace(/\/+$/,'');return register({kind:'prefix',path:routePrefix,handler:wrap(async(req,res)=>{
  const url=new URL(req.url,'http://local'),token=url.pathname.slice(routePrefix.length).replace(/^\//,'');if(!token||token.includes('/'))throw new FeatureHttpError(404,'下载不存在');const item=await handler(token,{req,method:req.method});if(!item)throw new FeatureHttpError(410,'下载已过期，请重新准备');const bytes=Buffer.from(item.body??item.bytes),name=String(item.filename??item.fileName??'download.bin').replace(/[\r\n"\\/]/g,'_');res.writeHead(200,{'content-type':item.mime??'application/octet-stream','content-length':bytes.length,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
 })});};
 registerGet({path:'/phone-features/csrf',handler:()=>({token:csrf})});
 return {assertRequest,registerAsset,registerApi,registerGet,registerDownload,close(){if(closed)return;closed=true;for(const dispose of disposers.splice(0).reverse())dispose();},status:()=>({pending,closed})};
}
