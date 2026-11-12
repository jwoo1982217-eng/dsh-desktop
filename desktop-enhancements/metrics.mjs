import {assistantStreamFirstTokenTime} from '@deepseek-ai/dsh-llm';

const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const duration=(a,b)=>finite(a)&&finite(b)&&b>=a?b-a:null;
function union(intervals){
 const ordered=intervals.filter(([a,b])=>finite(a)&&finite(b)&&b>=a).sort((a,b)=>a[0]-b[0]);let total=0,end=-1;
 for(const [a,b]of ordered){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;
}
function usageOf(value){
 if(!value||!finite(value.inputTokens)||!finite(value.outputTokens))return null;
 const read=finite(value.cacheReadTokens)?value.cacheReadTokens:0,write=finite(value.cacheWriteTokens)?value.cacheWriteTokens:0;
 return{inputTokens:value.inputTokens+read+write,outputTokens:value.outputTokens,cacheReadTokens:read,cacheWriteTokens:write};
}
function firstToken(stream){try{const value=assistantStreamFirstTokenTime(stream);return finite(value)?value:null;}catch{return null;}}
export function deriveMetrics(records,{hasMore=false,capped=false}={}){
 const events=[...new Map(records.map(r=>r.type==='event'?r.event:r).filter(e=>e&&Number.isSafeInteger(e.seq)).map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq);
 const rows=[],steps=new Map(),calls=new Map(),turns=new Map();let current,route,compaction;
 const make=(turn,step,event,known=false)=>{
  const key=turn+':'+step;if(!steps.has(key)){const row={kind:'step',id:key,turn,step,start:known?event.time:null,end:null,model:route?route.provider+'/'+route.model:null,status:'起止未知',modelMs:null,ttftMs:null,toolMs:null,toolSumMs:null,usage:null,retries:0,tools:[],_intervals:[]};steps.set(key,row);rows.push(row);}return steps.get(key);
 };
 const rowFor=e=>Number.isSafeInteger(e.data?.turn)&&Number.isSafeInteger(e.data?.step)?make(e.data.turn,e.data.step,e):current;
 for(const e of events){const d=e.data||{};
  if(e.type==='request/header'){route=d.header?.config;if(current&&route)current.model=route.provider+'/'+route.model;continue;}
  if(e.type==='turn/start'){turns.set(d.turn,{start:e.time,end:null});continue;}
  if(e.type==='step/start'){current=make(d.turn,d.step,e,true);current.start=e.time;current.status='运行中';continue;}
  if(e.type==='assistant/attempt'){const row=rowFor(e);if(row){const t=firstToken(d.stream);if(t!==null&&row._firstToken===undefined)row._firstToken=t;}continue;}
  if(e.type==='assistant/message'){
   const row=rowFor(e);if(row){const t=row._firstToken??firstToken(d.stream);row.modelMs=duration(row.start,e.time);row.ttftMs=duration(row.start,t);row.usage=usageOf(d.usage);row.decodeMs=duration(t,e.time);row.status=d.interrupted?'已中断':'模型已返回';}continue;
  }
  if(e.type==='tool/call'){
   const row=rowFor(e);if(row&&typeof d.callId==='string'){const tool={id:d.callId,name:String(d.name||'unknown'),start:e.time,end:null,ms:null,status:'运行中'};row.tools.push(tool);calls.set(d.callId,{row,tool});}continue;
  }
  if(e.type==='tool/result'){
   const id=d.message?.source?.callId??d.message?.toolCallId??d.callId,pair=calls.get(id);
   if(pair){pair.tool.end=e.time;pair.tool.ms=duration(pair.tool.start,e.time);pair.tool.status=d.message?.isError?'失败':'完成';pair.row._intervals.push([pair.tool.start,e.time]);calls.delete(id);}continue;
  }
  if(e.type==='llm/retry'){const row=rowFor(e);if(row)row.retries++;continue;}
  if(e.type==='step/end'){
   const row=rowFor(e);if(row){row.end=e.time;row.status=d.reason?.kind||d.reason||'本步结束';}if(current===row)current=null;continue;
  }
  if(e.type==='turn/end'){
   const turn=turns.get(d.turn);if(turn)turn.end=e.time;
   for(const row of rows)if(row.kind==='step'&&row.turn===d.turn&&row.end===null){row.end=e.time;row.status='已中断或起止不全';}
   for(const [id,pair]of calls)if(pair.row.turn===d.turn){pair.tool.status='未完成';calls.delete(id);}current=null;continue;
  }
  if(e.type==='compaction/start'){
   compaction={kind:'compaction',id:'compaction:'+e.seq,start:e.time,end:null,status:'压缩中',model:null,usage:null,toolMs:null,modelMs:null,ttftMs:null,tools:[]};rows.push(compaction);continue;
  }
  if(e.type==='compaction/summary'){
   if(!compaction){compaction={kind:'compaction',id:'compaction:'+e.seq,start:null,end:null,status:'压缩摘要已生成',tools:[],toolMs:null,modelMs:null,ttftMs:null};rows.push(compaction);}
   Object.assign(compaction,{usage:usageOf(d.usage),model:d.provider&&d.model?d.provider+'/'+d.model:null,shadowedTokens:finite(d.shadowedTokenCount)?d.shadowedTokenCount:null});continue;
  }
  if(e.type==='compaction/end'){
   if(!compaction){compaction={kind:'compaction',id:'compaction:'+e.seq,start:null,tools:[],toolMs:null,modelMs:null,ttftMs:null};rows.push(compaction);}
   Object.assign(compaction,{end:e.time,status:d.error?'压缩失败':'压缩结束'});compaction=null;
  }
 }
 for(const row of rows){
  row.wallMs=duration(row.start,row.end);
  if(row.kind==='step'){const intervals=row._intervals;row.toolMs=intervals.length?union(intervals):row.start!==null?0:null;row.toolSumMs=intervals.length?intervals.reduce((n,[a,b])=>n+b-a,0):row.toolMs;delete row._intervals;delete row._firstToken;}
  row.cacheHit=row.usage?.inputTokens>0?row.usage.cacheReadTokens/row.usage.inputTokens:null;
  row.outputPerSecond=row.usage&&row.decodeMs>0?row.usage.outputTokens*1000/row.decodeMs:null;delete row.decodeMs;
 }
 const sum=k=>{const values=rows.filter(r=>finite(r[k]));return values.length?values.reduce((n,r)=>n+r[k],0):null;},usageRows=rows.filter(r=>r.usage),input=usageRows.reduce((n,r)=>n+r.usage.inputTokens,0),output=usageRows.reduce((n,r)=>n+r.usage.outputTokens,0),cached=usageRows.reduce((n,r)=>n+r.usage.cacheReadTokens,0);
 return{range:{firstSeq:events[0]?.seq??null,lastSeq:events.at(-1)?.seq??null,events:events.length,hasMore,capped,scope:hasMore||capped?'已加载窗口':'完整已读日志'},
  totals:{steps:rows.filter(r=>r.kind==='step').length,turns:new Set(rows.filter(r=>r.kind==='step').map(r=>r.turn)).size,modelMs:sum('modelMs'),toolMs:sum('toolMs'),toolSumMs:sum('toolSumMs'),inputTokens:usageRows.length?input:null,outputTokens:usageRows.length?output:null,cacheHit:input>0?cached/input:null,usageReportedRows:usageRows.length},rows,
  notes:['输入 Token包含未缓存输入、缓存读取与缓存写入，不重复计算思考输出。','工具墙钟合并同一步的重叠调用；工具用时合计另列，不能与墙钟混称。','缺失步骤起点或供应商usage时显示未知；未调用模型补估。']};
}
