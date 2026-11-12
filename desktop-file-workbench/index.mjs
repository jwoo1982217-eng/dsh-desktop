import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FileWorkbench} from './files.mjs';
import {createFileWorkbenchHttp} from './http.mjs';
export const name='dsh-desktop-file-workbench';
export const inject=['webServer','connection','workspaceRegistry','fs'];
export function apply(ctx){
 const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
 const service=new FileWorkbench({home,workspaceRegistry:ctx.workspaceRegistry,fsProvider:ctx.fs});
 const assets=new Map([
  ['/desktop-files',{type:'text/html',bytes:fs.readFileSync(new URL('./page.html',import.meta.url))}],
  ['/desktop-files/page.js',{type:'text/javascript',bytes:fs.readFileSync(new URL('./page.js',import.meta.url))}],
  ['/desktop-files/page.css',{type:'text/css',bytes:fs.readFileSync(new URL('./page.css',import.meta.url))}],
 ]);
 const http=createFileWorkbenchHttp({connection:ctx.connection,service,assets});
 for(const route of [{kind:'exact',path:'/desktop-files'},{kind:'prefix',path:'/desktop-files'}])ctx.effect(()=>ctx.webServer.register({...route,handler:http.handle}));
 ctx.provide('dshDesktopFileWorkbench',{version:'0.1.0',status:http.status});
 ctx.effect(()=>async()=>{http.close();await service.close();});
}
