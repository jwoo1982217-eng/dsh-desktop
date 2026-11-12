import {AutomaticRecall as HistoryRecall} from './automatic-recall.mjs';
import {SummaryMemory} from './summary-memory.mjs';
// Additive layer: retain the signed release's managed history implementation.
export class AutomaticRecall extends HistoryRecall {
 constructor(home,memory){super(home,memory);this.summary=new SummaryMemory(home);}
 async prepare(payload,next){
  const status=this.summary.status();
  if(status.frozen||status.fault){this.cache.delete(payload.agent);return next();}
  const result=await super.prepare(payload,next),state=this.cache.get(payload.agent);
  if(state)state.rows=state.rows.filter(row=>this.summary.allowed(row));
  return result;
 }
 context(agent){
  if(this.closed||this.summary.status().frozen)return '';
  const summary=this.summary.context(agent,this.mode(agent?.session?.id));
  if(this.summary.status().fault)return summary;
  const state=this.cache.get(agent);if(state)state.rows=state.rows.filter(row=>this.summary.allowed(row));
  return [summary,super.context(agent)].filter(Boolean).join('\n');
 }
}
export function attachAutomaticRecall(ctx,home,memory,createSnapshot){
 const recall=new AutomaticRecall(home,memory);recall.snapshotFactory=createSnapshot;recall.refreshes=()=>typeof ctx.get('systemPrompt')?.refreshContext==='function';
 ctx.on('agent/pre-step',(payload,next)=>recall.before(payload,next));
 ctx.inject(['systemPrompt'],prompt=>{if(typeof prompt.systemPrompt.refreshContext!=='function')return;prompt.systemPrompt.context({name:'dsh:automatic-memory',order:24,interpolate:false,text:context=>recall.context(context.agent)});});
 ctx.on('dispose',()=>recall.close());return recall;
}
