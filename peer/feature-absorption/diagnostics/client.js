const $=id=>document.getElementById(id);let controller;
function busy(value){$('preview').disabled=value;$('export').disabled=value;}
function sources(snapshot){$('sources').replaceChildren();for(const source of snapshot.sources??[]){const item=document.createElement('li');item.textContent=source.name+' · '+(source.status==='ok'?'已收集':'暂时不可用');$('sources').append(item);}}
async function run(exporting){busy(true);controller=new AbortController();$('notice').textContent=exporting?'正在生成诊断包…':'正在读取诊断来源…';
 try{
  const response=await fetch('/phone-features/diagnostics/'+(exporting?'prepare':'snapshot'),{method:exporting?'POST':'GET',cache:'no-store',credentials:'same-origin',headers:exporting?{'content-type':'application/json'}:undefined,body:exporting?'{}':undefined,signal:controller.signal});
  if(!response.ok)throw Error('诊断信息暂时不可用，请稍后重试');
  if(exporting){
   const prepared=await response.json(),target=new URL(prepared.downloadUrl,location.href);
   if(target.origin!==location.origin||!/^\/phone-features\/diagnostics\/download(?:\/|$)/.test(target.pathname)||target.username||target.password||target.hash)throw Error('诊断下载地址无效，未下载');
   if(!/^[a-zA-Z0-9._-]+\.zip$/.test(prepared.fileName??''))throw Error('诊断文件名无效，未下载');
   if(prepared.snapshot)sources(prepared.snapshot);
   const link=document.createElement('a');link.href=target.href;link.download=prepared.fileName;document.body.append(link);link.click();link.remove();$('notice').textContent='诊断包已准备并交给下载。请从系统下载列表确认是否保存；不会自动发送。';
  }
  else{const snapshot=await response.json();sources(snapshot);$('notice').textContent='已读取收集范围；此页面不显示诊断详情或个人数据。';}
 }catch(error){if(error.name!=='AbortError')$('notice').textContent=error.message;}finally{busy(false);}
}
$('preview').onclick=()=>run(false);$('export').onclick=()=>run(true);window.addEventListener('pagehide',()=>controller?.abort(),{once:true});
