import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const marker='// DSH Desktop managed Pocket updater v1';
function replace(text,from,to){
  if(!text.includes(from))throw Error('Pocket 更新接口布局已变化，保留原安装，请从插件中心检查新版');
  return text.replace(from,to);
}
/** Apply a bounded adaptation to the installed package, also retained by subsequent updates. */
export async function patchPocket(directory){
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  if(pkg.name!=='dsh-pocket')throw Error('目标不是 Pocket');
  const hostFile=path.join(directory,'lib/index.js'),rpcFile=path.join(directory,'lib/web-rpc.js'),clientFile=path.join(directory,'client/client.js');
  let host=await readFile(hostFile,'utf8'),rpc=await readFile(rpcFile,'utf8'),client=await readFile(clientFile,'utf8');
  if(!host.includes(marker)){
    const start=host.indexOf('function performUpdate('),end=host.indexOf('\nexport function apply(',start);
    if(start<0||end<start)throw Error('Pocket 更新函数布局已变化，保留原安装');
    host=`${marker}\nimport {performDesktopUpdate} from './desktop-update/adapter.mjs';\n`+host.slice(0,start)+
      'function performUpdate(profile, { timeoutMs = 180_000 } = {}) {\n  return performDesktopUpdate({packageDirectory: dirname(pkgPath), profile, timeoutMs});\n}\n'+host.slice(end);
    rpc=replace(rpc,'if (result?.ok && restart) {','if (result?.ok && restart && result.restartRequired !== true) {');
    client=replace(client,'autoRestart: r.autoRestart === true,','autoRestart: r.autoRestart === true,\n        restartRequired: r.restartRequired === true,');
    client=replace(client,'style: styles.primary, onClick: runUpdate','type: "button", style: styles.primary, onClick: runUpdate');
    client=replace(client,') : updateInfo.autoRestart ?',') : updateInfo.restartRequired ? (0, import_react2.createElement)("button", {type: "button", style: styles.btn, disabled: true}, "重新打开 DSH 后生效") : updateInfo.autoRestart ?');
    client=replace(client,'{ style: styles.muted, marginTop: 4 },\n        updateInfo.updating','{ role: "alert", style: styles.muted, marginTop: 4 },\n        updateInfo.updating');
  }
  client=client.replace(/("updateFailed":\s*)"([^"\n]*)"/g,(_all,prefix,value)=>prefix+JSON.stringify(value.includes('\\u')||/[\u3400-\u9fff]/.test(value)?'更新失败：{err}。请点击更新按钮重试。':'Update failed: {err}. Click Update to retry.'));
  // Do not copy the source directory onto itself when adapting an already managed package.
  const source=path.dirname(fileURLToPath(import.meta.url)),dest=path.join(directory,'lib/desktop-update');
  await mkdir(dest,{recursive:true});
  if(path.resolve(source)!==path.resolve(dest))for(const file of ['adapter.mjs','patch.mjs'])await cp(path.join(source,file),path.join(dest,file));
  for(const [file,text]of[[hostFile,host],[rpcFile,rpc],[clientFile,client]])await writeFile(file,text);
  await writeFile(path.join(directory,'desktop-update.json'),JSON.stringify({version:1,packageVersion:pkg.version})+'\n');
  return {version:pkg.version,adapted:true};
}
