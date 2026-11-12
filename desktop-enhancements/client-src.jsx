import React from 'react';
export const inject=['slots'];
function Frame({sessionId,plugins=false}){
 const src='/desktop-enhancements'+(sessionId?'?sessionId='+encodeURIComponent(sessionId):'')+(plugins?'#plugins':'');
 return <iframe title={plugins?'插件更新':'耗时与缓存统计'} src={src} style={{display:'block',width:'100%',height:plugins?'min(76dvh,850px)':'100%',minHeight:400,border:0}}/>;
}
export function apply(ctx){
 ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'desktop-metrics',order:20,label:()=> '统计',inject:sessionId=>({sessionId})},Frame));
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'desktop-plugin-updates',label:'插件更新',order:38},()=> <Frame plugins/>));
}
