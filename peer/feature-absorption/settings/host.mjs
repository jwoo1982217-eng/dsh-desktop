import {readFileSync} from 'node:fs';
import {SETTINGS_CATALOG,validateEntry,rankSettings} from './catalog.mjs';

export const SETTINGS_ASSETS=Object.freeze([
 {path:'/phone-features/settings',file:new URL('./page.html',import.meta.url),type:'text/html'},
 {path:'/phone-features/settings/client.js',file:new URL('./client.js',import.meta.url),type:'text/javascript'},
 {path:'/phone-features/settings/focus.js',file:new URL('./focus.js',import.meta.url),type:'text/javascript'},
 {path:'/phone-features/settings/focus.css',file:new URL('./focus.css',import.meta.url),type:'text/css'},
 {path:'/phone-features/settings/style.css',file:new URL('./style.css',import.meta.url),type:'text/css'},
]);
/** availableRoutes is a Set, or a synchronous function returning the registered route Set. */
export function createSettingsSearch({availableRoutes,entries=[]}={}){
 const registered=new Map(SETTINGS_CATALOG.map(x=>[x.id,[{token:null,entry:validateEntry(x)}]]));
 const register=values=>{
  if(!Array.isArray(values)||values.length>256)throw Error('Settings index exceeds its limit');
  const parsed=values.map(validateEntry);if(new Set(parsed.map(x=>x.id)).size!==parsed.length)throw Error('Duplicate settings entry');
  if(registered.size+parsed.filter(x=>!registered.has(x.id)).length>512)throw Error('Settings index exceeds its limit');
  const token=Symbol('settings-registration');for(const entry of parsed){const layers=registered.get(entry.id)??[];layers.push({token,entry});registered.set(entry.id,layers);}
  return()=>{for(const {id}of parsed){const layers=registered.get(id)?.filter(x=>x.token!==token)??[];if(layers.length)registered.set(id,layers);else registered.delete(id);}};
 };
 register(entries);
 const catalog=()=>{
  const routes=typeof availableRoutes==='function'?availableRoutes():availableRoutes;
  return [...registered.values()].map(layers=>layers.at(-1).entry).filter(entry=>!routes||routes.has(new URL(entry.href,'http://dsh.local').pathname));
 };
 return {catalog,register,search:(query,options)=>({query:String(query??''),items:rankSettings(catalog(),query,options)}),
  assets:SETTINGS_ASSETS.map(x=>({...x,bytes:readFileSync(x.file)}))};
}
