import {readFileSync} from 'node:fs';
// Pocket 2.12 targets the pre-0.2 AppFrame child order. DSH 0.2 adds a drawer mask.
// Limit this adapter to Pocket mobile frames with that new mask; transport is untouched.
export const name='dsh-pocket-layout-compat';
export const inject=['webServer'];
export const css=`@media(max-width:700px){
body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"]:has(>[class$="_drawerMask"])>[class$="_centerCol"]{grid-column:1!important;grid-row:1!important;min-width:0!important}
body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"]:has(>[class$="_drawerMask"])>[class$="_sidebarCol"]{position:absolute!important;inset:0 auto 0 0!important;width:max-content!important;max-width:92vw!important;z-index:1200!important;transform:translateX(-110%)!important;visibility:hidden!important;pointer-events:none!important}
body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"]:not([data-sidebar-collapsed]):has(>[class$="_drawerMask"])>[class$="_sidebarCol"],body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"]:has(>[class$="_drawerMask"])>[class$="_sidebarCol"]:has([aria-modal="true"]){transform:none!important;visibility:visible!important;pointer-events:auto!important}
body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"]>[class$="_drawerMask"]{display:none!important}
}`;
export const catalogPath='/phone-features/settings/pocket-model-catalog-budget.js';
export function htmlWithPocketLayout(html){
 html=html.replaceAll('src="/phone-features/settings/model-catalog-budget.js"','src="'+catalogPath+'"');
 return html.includes('id="dsh-pocket-layout-compat"')?html:html.replace(/<head(?:\s[^>]*)?>/i,head=>head+'<style id="dsh-pocket-layout-compat">'+css+'</style>');
}
const key=Symbol.for('dsh.pocket.layout.compat.v2');
export function acquire(web){
 let state=web[key];if(!state){
  const body=readFileSync(new URL('./pocket-model-catalog-budget.js',import.meta.url));
  const asset=web.register({kind:'exact',path:catalogPath,handler(_req,res){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(body);}});
  let tap;try{tap=web.tapIndex(htmlWithPocketLayout);}catch(error){asset();throw error;}
  state={owners:new Set(),release(){tap();asset();}};web[key]=state;
 }
 const owner={};state.owners.add(owner);
 return()=>{state.owners.delete(owner);if(!state.owners.size&&web[key]===state){state.release();delete web[key];}};
}
export function apply(ctx){const release=acquire(ctx.get('webServer'));ctx.effect(()=>release);}
