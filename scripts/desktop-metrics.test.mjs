import test from 'node:test';import assert from 'node:assert/strict';
import {deriveMetrics} from '../desktop-enhancements/metrics.mjs';
import {MetricsReader} from '../desktop-enhancements/history.mjs';
const event=(seq,type,time,data={})=>({type:'event',event:{seq,type,time,data}});
function fixture(){return[
 event(0,'request/header',0,{header:{config:{provider:'fixture',model:'main'}}}),event(1,'turn/start',0,{turn:1}),event(2,'step/start',100,{turn:1,step:0}),
 event(3,'assistant/message',1100,{turn:1,step:0,usage:{inputTokens:100,cacheReadTokens:300,cacheWriteTokens:100,outputTokens:50},stream:[{type:'chunk',time:400,chunk:{type:'text-delta',index:0,text:'hello'}}]}),
 event(4,'tool/call',1200,{callId:'a',name:'read',turn:1,step:0}),event(5,'tool/call',1300,{callId:'b',name:'grep',turn:1,step:0}),
 event(6,'tool/result',1600,{message:{source:{callId:'a'},isError:false}}),event(7,'tool/result',1800,{message:{source:{callId:'b'},isError:false}}),event(8,'step/end',1900,{turn:1,step:0}),event(9,'turn/end',2000,{turn:1})];}
test('timing, provider usage and weighted cache use actual events; parallel tools are not double-counted',()=>{
 const r=deriveMetrics(fixture()),row=r.rows[0];assert.equal(row.model,'fixture/main');assert.equal(row.modelMs,1000);assert.equal(row.ttftMs,300);assert.equal(row.toolMs,600);assert.equal(row.toolSumMs,900);assert.equal(row.wallMs,1800);assert.equal(row.usage.inputTokens,500);assert.equal(row.cacheHit,.6);assert.equal(r.totals.cacheHit,.6);assert.equal(r.totals.outputTokens,50);
});
test('incomplete paged windows report unknown starts, missing usage and partial scope',()=>{
 const r=deriveMetrics(fixture().slice(3),{hasMore:true});assert.equal(r.rows[0].modelMs,null);assert.equal(r.rows[0].ttftMs,null);assert.equal(r.rows[0].wallMs,null);assert.equal(r.range.scope,'已加载窗口');
 const missing=deriveMetrics([event(1,'step/end',10,{turn:4,step:1})],{hasMore:true});assert.equal(missing.totals.inputTokens,null);assert.equal(missing.totals.modelMs,null);assert.equal(missing.rows[0].toolMs,null);
});
test('compaction usage is read from its summary, closed by lifecycle end and kept out of ordinary steps',()=>{
 const r=deriveMetrics([event(0,'compaction/start',100,{compactionId:'c'}),event(1,'compaction/summary',900,{compactionId:'c',provider:'old',model:'large',usage:{inputTokens:1000,outputTokens:80},shadowedTokenCount:60000}),event(2,'compaction/end',1000,{compactionId:'c'})]);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].wallMs,900);assert.equal(r.rows[0].model,'old/large');assert.equal(r.rows[0].usage.outputTokens,80);assert.equal(r.totals.steps,0);
});
test('retries, cancelled steps and unmatched tools stay visible without fabricated model times',()=>{
 const r=deriveMetrics([event(0,'step/start',100,{turn:1,step:0}),event(1,'llm/retry',200,{turn:1,step:0}),event(2,'tool/call',300,{callId:'a',name:'run_code',turn:1,step:0}),event(3,'turn/end',600,{turn:1,reason:{kind:'interrupted'}})]);
 assert.equal(r.rows[0].retries,1);assert.equal(r.rows[0].modelMs,null);assert.equal(r.rows[0].tools[0].status,'未完成');assert.equal(r.rows[0].tools[0].ms,null);assert.equal(r.totals.inputTokens,null);
});
test('event pages are ordered and duplicate sequences are counted once',()=>{
 const rows=fixture();assert.deepEqual(deriveMetrics([...rows,...rows].reverse()),deriveMetrics(rows));
});
test('PTC inner-dispatch records do not add duplicate root-tool wall time',()=>{
 const rows=fixture();rows.splice(6,0,event(51,'tool/ptc-dispatch-start',1350,{rootCallId:'a',name:'read'}),event(52,'tool/ptc-dispatch',1500,{rootCallId:'a',name:'read'}));
 assert.equal(deriveMetrics(rows).totals.toolMs,600);
});
test('read uses the public cold-safe history stream and closes it without creating an Agent',async()=>{
 let closed=false,creates=0;const controller={async *follow(request,signal){assert.equal(request.address.sessionId,'session-fixture');assert.equal(request.maxMessages,200);try{yield{type:'snapshot',records:fixture(),hasMore:true,cursor:10};throw Error('must not continue following');}finally{closed=true;assert.equal(signal.aborted,true);}}};
 const reader=new MetricsReader({get:key=>key==='sessionController'?controller:key==='agents'?{create:()=>creates++}:undefined});const result=await reader.read('session-fixture');assert.equal(result.totals.steps,1);assert.equal(closed,true);assert.equal(creates,0);
});
