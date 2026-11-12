import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MetricsReader} from './history.mjs';
import {PluginUpdates} from './updates.mjs';

export const name='dsh-desktop-enhancements';
export const inject=['webServer','connection','sessionController','pluginManager'];
export function apply(ctx){
 const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
 const profile=ctx.get('profileContext')?.dir||ctx.get('profileContext')?.profile?.dir;
 const metrics=new MetricsReader(ctx),updates=new PluginUpdates(ctx,{home,profile});
 ctx.provide('dshDesktopEnhancements',{metrics,updates});
 ctx.on('dispose',()=>updates.close());
 ctx.connection.rpc.handle('/desktop-enhancements',async(method,payload,signal)=>{
  try{
   if(method!=='manage'||!payload||typeof payload.action!=='string')throw Error('请求无效');
   let value;switch(payload.action){
    case 'status':value={version:'0.1.0',core:'0.2.1-alpha.4',residentAgents:ctx.get('agents')?.list?.().length??null,profileResolved:!!profile,update:updates.status()};break;
    case 'sessions':value=await metrics.sessions(signal);break;
    case 'metrics':value=await metrics.read(payload.id,payload.limit??200,signal);break;
    case 'plugins':value=await updates.list();break;
    case 'update.plan':value=await updates.plan(payload.name,payload.version||'latest',signal);break;
    case 'update.execute':if(payload.confirm!==true)throw Error('需要确认准确的插件和版本');value=await updates.execute(payload.id);break;
    case 'update.cancel':value=await updates.cancel();break;
    default:throw Error('未知操作');
   }
   return{ok:true,value};
  }catch(error){return{ok:false,error:{code:'desktop-enhancements/failed',message:String(error.message||error),details:{}}};}
 },{authority:'loopback'});
 for(const[route,file,type]of[['/desktop-enhancements','page.html','text/html'],['/desktop-enhancements/page.js','page.js','text/javascript'],['/desktop-enhancements/page.css','page.css','text/css']]){
  const bytes=fs.readFileSync(new URL(file,import.meta.url));
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:route,handler(req,res){if(req.method!=='GET'){res.writeHead(405).end();return;}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(bytes);}}));
 }
}
