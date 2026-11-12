// These routes and anchors are existing DSH pages; the search never writes settings.
const row=(id,title,english,group,href,anchor,synonyms=[])=>({id,title,english,group,href,anchor,synonyms});
export const SETTINGS_CATALOG=Object.freeze([
 row('personas','Agent 人设','Agent personas','助手','/agent-cards','selection-title',['角色','人格','主卡','persona']),
 row('persona-combinations','人设组合','Persona combinations','助手','/agent-cards','combos-title',['组合','副卡','角色组合']),
 row('persona-import','导入与导出人设','Import and export personas','助手','/agent-cards','transfer-title',['人设导入','角色导出']),
 row('scheduler','子代理调度','Subagent scheduler','助手','/subagent-scheduler','settings',['派单','并发','delegation']),
 row('scheduler-models','子代理模型路由','Subagent model routing','助手','/subagent-scheduler','routes',['模型调度','model routing']),
 row('scheduler-cooldowns','模型冷却状态','Model cooldowns','助手','/subagent-scheduler','cooldowns',['限流','cooldown']),
 row('memory-recall','自动记忆召回','Automatic memory recall','记忆','/knowledge-link#memory','automatic-recall',['自动回忆','长期记忆','recall']),
 row('memory-sources','记忆来源','Memory sources','记忆','/knowledge-link#memory','sources',['知识来源','记忆索引']),
 row('memory-search','记忆检索','Search memories','记忆','/knowledge-link#memory','query',['搜索记忆','memory search']),
 row('transfer-devices','技能与经验设备连接','Skill and experience devices','传递','/knowledge-link#transfer','devices-section',['设备配对','知识传递','经验同步']),
 row('transfer-send','发送技能与经验','Send skills and experience','传递','/knowledge-link#transfer','send-section',['发送技能','分享经验']),
 row('transfer-inbox','接收技能与经验','Receive skills and experience','传递','/knowledge-link#transfer','receive-section',['接收箱','收件箱','inbox']),
 row('mcp-services','MCP 服务','MCP services','插件','/mcp-manager','servers',['MCP服务器','外部工具','tools server']),
 row('mcp-directory','MCP 扩展目录','MCP extension directory','插件','/mcp-manager','extensionDirectory',['服务目录','extensions']),
 row('media-jobs','图片视频语音任务','Media jobs','插件','/mcp-manager','mediaJobs',['生成图片','生成视频','语音合成','media']),
 row('media-pricing','媒体费用设置','Media pricing','插件','/mcp-manager','pricing',['费用','计价','pricing']),
 row('plugin-market','插件市场','Plugin market','插件','/controlled-market','plugins',['插件商店','扩展市场','marketplace']),
 row('plugin-trials','插件试用','Plugin trials','插件','/controlled-market','trial-control',['试用','试运行']),
 row('skills-import','技能包导入','Import skill packs','技能','/phone-packs','zip',['ZIP技能','技能文件','skill import']),
 row('skills-search','查找已安装技能','Find installed skills','技能','/phone-packs','search',['已装技能','技能搜索']),
 row('prompt-cards','提示卡','Prompt cards','技能','/phone-packs','prompts',['提示词','prompt cards']),
 row('phone-runtimes','手机运行环境','Phone runtimes','环境','/phone-packs','runtime',['Python环境','Node环境','runtime']),
 row('skill-editor','单文档技能编辑','Edit a skill document','技能','/phone-skills','manualEditor',['Markdown技能','手动技能']),
 row('workspace-files','手机工作区文件','Phone workspace files','工作区','/phone-workspace','files',['文件列表','工作文件']),
 row('workspace-editor','工作区文件编辑','Workspace file editor','工作区','/phone-workspace','file',['编辑代码','代码文件']),
 row('qq-connection','QQ 连接','QQ connection','QQ','/phone-bot','connection',['机器人登录','QQ登录','NapCat']),
 row('qq-personality','QQ 性格','QQ personality','QQ','/phone-bot','personality',['QQ人设','机器人性格']),
 row('qq-groups','QQ 群聊','QQ groups','QQ','/phone-bot','groups',['群消息','群聊设置']),
]);

export function normalizeQuery(value){return String(value??'').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s/gu,'');}
export function validateEntry(value){
 if(!value||typeof value.id!=='string'||!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.id)||typeof value.title!=='string'||!value.title.trim())throw Error('Invalid setting entry');
 const target=new URL(String(value.href??''),'http://dsh.local');
 if(target.origin!=='http://dsh.local'||!String(value.href).startsWith('/')||String(value.href).startsWith('//')||target.username||target.password||target.search||/[\r\n\\]/.test(value.href))throw Error('Settings must use an existing same-origin page');
 if(value.anchor!==undefined&&(!/^[A-Za-z][\w:.-]{0,99}$/.test(value.anchor)))throw Error('Invalid setting anchor');
 if(!Array.isArray(value.synonyms??[])||(value.synonyms??[]).some(x=>typeof x!=='string'||x.length>100))throw Error('Invalid setting synonyms');
 return Object.freeze({id:value.id,title:value.title.slice(0,120),english:String(value.english??'').slice(0,120),group:String(value.group??'设置').slice(0,60),href:target.pathname+target.hash,anchor:value.anchor,synonyms:Object.freeze([...(value.synonyms??[])].slice(0,24))});
}
export function rankSettings(entries,query,{limit=20}={}){
 const q=normalizeQuery(query);if(!q)return [];
 if(q.length>200)throw Error('搜索词最多 200 个字符');
 const ranked=[];
 entries.forEach((entry,order)=>{
  let score=0,matchedBy='';
  for(const title of [entry.title,entry.english]){
   const n=normalizeQuery(title),candidate=n===q?120:n.startsWith(q)?100:n.includes(q)?80:0;
   if(candidate>score){score=candidate;matchedBy='title';}
  }
  for(const alias of entry.synonyms){const n=normalizeQuery(alias),candidate=n===q?70:n.includes(q)?60:0;if(candidate>score){score=candidate;matchedBy='synonym';}}
  if(!score&&normalizeQuery(entry.group+' '+entry.href+' '+(entry.anchor??'')).includes(q)){score=30;matchedBy='path';}
  if(score)ranked.push({...entry,score,matchedBy,order});
 });
 return ranked.sort((a,b)=>b.score-a.score||a.order-b.order).slice(0,Math.max(1,Math.min(60,Number.isSafeInteger(limit)?limit:20))).map(({order,...entry})=>entry);
}
