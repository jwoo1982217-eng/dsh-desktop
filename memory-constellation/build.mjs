import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url);
let html=fs.readFileSync(new URL('upstream/lib/constellation.html',root),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/);
if(!script)throw Error('Upstream script not found');
let js=script[1];
html=html.replace(script[0],'<script src="/meow-constellation/page.js"></script>');
html=html.replaceAll('读取 meow-memory 记忆库','读取 DSH 知识库与记忆摘要').replace('包含归档 / 已完结','包含归档笔记').replace('id="autorotate" checked','id="autorotate"');
html=html.replace('<select id="workspace"','<select aria-label="记忆来源" id="workspace"');
html=html.replace('<input type="text" id="search"','<input aria-label="搜索记忆" type="text" id="search"');
html=html.replace('.left { display: none; }','.left { display: flex; left: 16px; width: 205px; }');
html=html.replace('<div class="btns">','<div id="results" aria-live="polite"></div><div class="btns">');
html=html.replace('</style>',`\n#results{max-height:170px;overflow:auto;margin:10px 0}#results button{display:block;width:100%;text-align:left;margin:5px 0;padding:7px;color:#d5dfff;background:#14213b;border:1px solid #31466b;border-radius:7px;cursor:pointer}.d-content{max-height:40vh;overflow:auto}.d-source{color:#9bb9ff}.left{max-height:calc(100vh - 150px);overflow:auto}.detail button{cursor:pointer}.empty-note{color:#bccbe8;font-size:12px;line-height:1.7}@media(max-width:700px){.topbar{left:16px;right:16px}.brand{font-size:20px;letter-spacing:3px}.status{font-size:10px;max-width:52%}.left{width:170px}.card{padding:12px}.detail{right:8px;width:min(310px,calc(100vw - 190px))}.hint{white-space:normal;width:90%;text-align:center;font-size:10px}.legend-row{padding:3px}.detail{padding:16px}}\n</style>`);
html=html.replace('点击光点，拾起一段记忆','点击光点查看原文 · 连线沿用知识库链接与共同标签');
html=html.replace('</style>',`\n.embedded .brand{display:none}.embedded .topbar{top:16px;left:16px;right:16px;justify-content:flex-end}.embedded .status{font-size:11px;max-width:70%;text-align:right}.embedded .left{top:60px;left:16px;width:210px;gap:10px;max-height:calc(100vh - 92px)}.embedded .card{padding:12px}.embedded .legend-row{padding:4px}.embedded .card-title{margin-bottom:8px}.embedded .detail{right:16px;width:min(380px,calc(100vw - 250px));max-height:85vh;padding:20px}.embedded .hint{bottom:10px;letter-spacing:0;font-size:11px}.embedded .d-source{padding:8px 12px;border:1px solid #526b9c;border-radius:8px;background:#14213b}.embedded #results{max-height:110px}@media(max-width:600px){.embedded .left{width:155px}.embedded .detail{width:calc(100vw - 190px);padding:12px}.embedded .d-title{font-size:18px}.embedded .status{max-width:100%}}\n</style>`);
const replace=(from,to)=>{if(!js.includes(from))throw Error('Upstream anchor changed: '+from.slice(0,60));js=js.replace(from,to);};
replace("  'use strict';", "  'use strict';\n  var embedded=new URLSearchParams(location.search).get('embedded')==='1';\n  if(embedded)document.body.classList.add('embedded');");
replace("label: 'AI 自身'","label: '写作'");replace("label: '用户'","label: '偏好'");replace("label: '准则'","label: '归档'");replace("label: '话题'","label: '知识'");replace("label: '事实'","label: '记录'");replace("label: '经验'","label: '进度'");
replace('autoRotate = true','autoRotate = false');
replace('id: key, rawId: it.id, workspaceName: it.workspaceName,','id: key, rawId: it.id, workspaceName: it.source, sourceUrl: it.sourceUrl, truncated: it.truncated,');
const start=js.indexOf('  function buildLinks('),end=js.indexOf('  /* ── 3D',start);
js=js.slice(0,start)+`  function buildLinks(nodes) {
    var byId=new Map(nodes.map(function(n){return [n.id,n];}));
    return (DATA && DATA.edges || []).filter(function(e){return byId.has(e.from)&&byId.has(e.to);}).map(function(e){return [byId.get(e.from),byId.get(e.to),e];});
  }
`+js.slice(end);
replace("return m.id !== n.id && ((n.project && m.project === n.project) || n.keywords.some(function (k) { return (m.keywords || []).indexOf(k) >= 0; }));","return (DATA.edges || []).some(function(e){return (e.from===n.id&&e.to===m.id)||(e.to===n.id&&e.from===m.id);});");
replace("return '<a data-id=\"' + esc(m.id) + '\">[' + esc(LAYERS[m.level].label) + '] ' + esc(short(m.title || m.content, 30)) + '</a>';",`var edge=(DATA.edges||[]).find(function(e){return (e.from===n.id&&e.to===m.id)||(e.to===n.id&&e.from===m.id);});
      return '<a data-id="'+esc(m.id)+'">'+esc(short(m.title||m.content,30))+' <small>('+esc(edge.kind==='link'?'笔记链接':'共同标签：'+(edge.tags||[]).join('、'))+')</small></a>';`);
replace("+ '<dt>重要性</dt><dd class=\"stars\">' + stars + '　' + n.importance + '</dd>'", "+ '<dt>内容</dt><dd>来源原文，按需引用</dd>'");
replace("+ '<dt>命中</dt><dd>' + (n.hitCount || 0) + ' 次</dd>'", "");
replace("+ '<div class=\"d-content\">' + esc(n.content) + '</div>'", `+ '<div class="d-content">' + esc(n.content) + '</div>'
      + (n.truncated ? '<p class="empty-note">当前展示前 12000 字符，可分段读取完整原文。</p><button id="read-more">继续读取原文</button>' : '')
      + (embedded&&n.id.indexOf('knowledge:')===0 ? '<p><button class="d-source" id="open-note">在知识库中打开</button></p>' : '<p><a class="d-source" href="'+esc(n.sourceUrl||'/knowledge-base')+'">打开来源知识库</a></p>')`);
replace("var copy = $('copy-id');",`var more=$('read-more');
    if(more)more.addEventListener('click',async function(){try{var d=await api('/meow-constellation/api/read?id='+encodeURIComponent(n.id)+'&offset='+n.content.length);if(!d.ok)throw Error(d.error);n.content+=d.item.content;n.truncated=d.item.nextOffset!==null;showDetail(n);}catch(e){toast(e.message);}});
    var openNote=$('open-note');
    if(openNote)openNote.addEventListener('click',function(){parent.postMessage({type:'dsh-memory-constellation:open-note',id:n.id.slice('knowledge:'.length)},location.origin);});
    var copy = $('copy-id');`);
// No fake data is shipped in the integrated product; unavailable is visible and clears stale memory.
const demoStart=js.indexOf('  function demoData()'),demoEnd=js.indexOf('  function setStatus(',demoStart);
js=js.slice(0,demoStart)+js.slice(demoEnd);
const applyDemoStart=js.indexOf('  function applyDemo()'),applyDemoEnd=js.indexOf('  function updateLegend()',applyDemoStart);
js=js.slice(0,applyDemoStart)+`  function showError(error) { DATA=null; NODES=[]; LINKS=[]; selected=null; showDetail(null); updateLegend(); renderResults(); setStatus('连接失败：'+error.message,false); }
  function renderResults(){
    var rows=NODES.filter(function(n){return visible(n)&&matches(n);}).slice(0,30);
    $('results').innerHTML=rows.length?rows.map(function(n){return '<button data-id="'+esc(n.id)+'">'+esc(short(n.title||n.content,40))+'</button>';}).join(''):'<p class="empty-note">'+(DATA?'没有匹配的记忆':'等待知识库连接')+'</p>';
    $('results').querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){select(NODES.find(function(n){return n.id===b.dataset.id;}));});});
  }
`+js.slice(applyDemoEnd);
replace('      updateLegend();\n    }','      updateLegend(); renderResults();\n    }');
replace("setStatus(d.workspaceName + '　·　更新于 ' + fmt(d.generatedAt), !!d.demo);", "setStatus(d.workspaceName + ' · ' + d.edges.length + ' 条关联' + (d.limited ? ' · 仅展示最近 500 条，可用工具检索全部' : '') + (d.graphLimited ? ' · 关联范围沿用知识库最近 120 篇' : '') + ' · 更新于 ' + fmt(d.generatedAt), false);");
replace("全部工作区 · ","全部来源 · ");
replace("row.classList.toggle('off', hidden.has(lv));","row.classList.toggle('off', hidden.has(lv)); renderResults();");
replace("if (!DATA) applyDemo();\n      else if (!DATA.demo) setStatus('同步失败：' + e.message + '（保留上次数据）', false);","showError(e);");
replace("search = e.target.value.trim();","search = e.target.value.trim(); renderResults();");
replace("setStatus('读取 meow-memory 记忆库', false);","setStatus('读取 DSH 知识库与记忆摘要', false);");
replace("loadWorkspaces().catch(function () { /* off-host demo */ })","loadWorkspaces().catch(showError)");
replace('    if (autoRotate && !dragging) rotY += 0.0012;\n    draw();','    if (!document.hidden) { if (autoRotate && !dragging) rotY += 0.0012; draw(); }');
// All three interfaces query the knowledge workbench's shared recall service.
js=js.replace("var search = '',", "var recalled=null, recallRequest=0, searchTimer;\n  var search = '',");
replace("    if (!search) return true;", "    if (!search) return true;\n    if(recalled)return recalled.items.some(function(r){return r.id===n.id;});");
const resultStart=js.indexOf('  function renderResults(){'), resultEnd=js.indexOf('  function updateLegend()',resultStart);
js=js.slice(0,resultStart)+`  function why(n){return (n.reasons||[]).map(function(r){return r.kind==='relation'?'关联自 '+r.title+'（'+(r.edge==='link'?'笔记链接':'共同标签')+'）':r.kind==='semantic'?'语义相关':r.kind==='keyword'?'关键词命中':'历史关键词';}).join(' · ');}
  function renderResults(){
    var rows=search?(recalled?recalled.items:[]):NODES.filter(function(n){return visible(n);}).slice(0,30);
    $('results').innerHTML=rows.length?rows.map(function(n){return '<button data-id="'+esc(n.id)+'">'+esc(short(n.title||n.content,40))+(search?'<small style="display:block;margin-top:4px">'+esc(why(n))+'</small>':'')+'</button>';}).join(''):'<p class="empty-note">'+(search&&!recalled?'正在联想查找…':DATA?'没有匹配的记忆':'等待知识库连接')+'</p>';
    if(recalled&&recalled.warnings.length)$('results').insertAdjacentHTML('beforeend','<p class="empty-note">'+esc(recalled.warnings.join(' '))+'</p>');
    $('results').querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){var found=rows.find(function(n){return n.id===b.dataset.id;}),node=NODES.find(function(n){return n.id===b.dataset.id;});if(!node&&found)node=buildNodes([found])[0];if(node){node.reasons=found.reasons;select(node);}});});
  }
  async function recallSearch(){var request=++recallRequest;if(!search){recalled=null;renderResults();return;}try{var data=await api('/meow-constellation/api/search?q='+encodeURIComponent(search)+'&scope='+encodeURIComponent(workspace||'__all__'));if(request!==recallRequest)return;if(!data.ok)throw Error(data.error);recalled=data;renderResults();}catch(e){if(request!==recallRequest)return;recalled={items:[],warnings:[e.message]};renderResults();}}
`+js.slice(resultEnd);
replace("search = e.target.value.trim(); renderResults();", "search = e.target.value.trim(); recalled=null;recallRequest++;clearTimeout(searchTimer);renderResults();searchTimer=setTimeout(recallSearch,250);");
replace("      updateLegend(); renderResults();", "      updateLegend(); renderResults();if(search)recallSearch();");
replace("+ '<div class=\"d-content\">' + esc(n.content) + '</div>'", "+ (n.reasons?'<p class=\"empty-note\">联想依据：'+esc(why(n))+'</p>':'') + '<div class=\"d-content\">' + esc(n.content) + '</div>'");
replace("embedded&&n.id.indexOf('knowledge:')===0", "embedded&&(n.id.indexOf('knowledge:')===0||n.id.indexOf('summary:')===0)");
replace("id:n.id.slice('knowledge:'.length)", "id:n.id");
fs.writeFileSync(new URL('page.html',root),html);fs.writeFileSync(new URL('page.js',root),js.replace(/[ \t]+$/gm,''));
fs.copyFileSync(new URL('upstream/LICENSE',root),new URL('LICENSE',root));
console.log('Built integrated star map:',fileURLToPath(root));
