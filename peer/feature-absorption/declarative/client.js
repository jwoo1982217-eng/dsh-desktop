import {mountContribution} from './renderer.mjs';
import {applyFeatureResult} from './host-adapter.mjs';
const root=document.getElementById('contributions'),status=document.getElementById('status'),button=document.getElementById('refresh'),mounts=[];
let epoch=0,closed=false;
async function rpc(payload,{signal}={}){const response=await fetch('/phone-features/declarative/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin',signal});let result;try{result=await response.json();}catch{throw Error('请求未完成（'+response.status+'）');}if(!response.ok||!result.ok)throw Error((typeof result.error==='string'?result.error:result.error?.message)??'请求未完成（'+response.status+'）');return result.value;}
async function refresh(){
 const own=++epoch;button.disabled=true;status.textContent='正在读取插件界面…';
 try{const result=await rpc({action:'list'});if(closed||own!==epoch)return;for(const item of mounts)item.dispose();mounts.length=0;root.replaceChildren();for(const item of result.items)mounts.push(mountContribution(document,root,item,{sendEvent:rpc,onResult:applyFeatureResult}));status.textContent=result.items.length?'共 '+result.items.length+' 个插件界面':'暂时没有插件提供这些界面。';}
 catch(error){if(!closed&&own===epoch)status.textContent=error.message;}
 finally{if(!closed&&own===epoch)button.disabled=false;}
}
button.addEventListener('click',()=>void refresh());window.addEventListener('pagehide',()=>{closed=true;epoch++;for(const item of mounts)item.dispose();});void refresh();
