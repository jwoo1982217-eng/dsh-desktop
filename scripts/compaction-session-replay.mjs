// Read a private Session snapshot, exercise both implementations in isolation,
// and save only statistics. No source log, task file or network is modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Llm, {LlmAdapter,LlmError} from '@deepseek-ai/dsh-llm';
import {estimateMessage,estimateToolsTokens} from '@deepseek-ai/dsh-token-meter/estimate';
import {BasicCompactionEngine} from '../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/index.js';

const [source,oldFile,output]=process.argv.slice(2);
if(!source||!oldFile||!output)throw Error('Usage: compaction-session-replay.mjs SESSION_FILE OLD_ENGINE OUTPUT_JSON');
const bytes=fs.readFileSync(source),hash=b=>createHash('sha256').update(b).digest('hex');
let offset=0,decoded='',frames=0;
while(offset<bytes.length){const d=zstdDecompressSync(bytes.subarray(offset),{info:true});if(d.engine.bytesWritten<1)throw Error('invalid frame progress');decoded+=d.buffer.toString();offset+=d.engine.bytesWritten;frames++;}
const records=decoded.trim().split('\n').map(s=>JSON.parse(s)),events=records.filter(e=>Number.isSafeInteger(e.seq));
const first=events.findIndex(e=>e.type==='compaction/start'&&e.data.turn>=27);
const prune=events.findIndex(e=>e.type==='compaction/prune');
const seed=events.slice(0,Math.min(first<0?events.length:first,prune<0?events.length:prune));
const providers=[...new Set(seed.filter(e=>e.type==='request/header').map(e=>e.data.header.config.provider))];
const {BasicCompactionEngine:Old}=await import(pathToFileURL(oldFile).href);
const response='## Primary Request and Intent\n- Preserve the original local audio import requirements and user corrections.\n## Files and Code\n- LocalAudioBookImporter.kt: EventBus call under investigation.\n## Errors and Fixes\n- Recheck the current diff and tool results.\n## Pending Jobs\n- Finish the implementation and run compilation.\n## Current Work\n- Read EventBus usage.\n## Next Step\n- Read on-disk code before editing; do not repeat uncertain actions.\n## Critical Context\n- Keep existing playback contracts.';
async function replay(Engine){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-source-replay-')),prior=process.env.DSH_HOME;process.env.DSH_HOME=home;
 const ctx=new Context(),calls=[];
 try{
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
   async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:262144},defaultMaxTokens:8192};}
   async *stream(o){const tokens=o.messages.reduce((n,m)=>n+estimateMessage(m),0)+estimateToolsTokens({tools:o.tools});calls.push({tokens,tools:o.tools?.length||0});if(tokens+o.maxTokens>262144)throw new LlmError('pi-ai detected context overflow for model "glm-5.3-flash"','CONTEXT_WINDOW_EXCEEDED');yield {type:'text-delta',index:0,text:response};yield {type:'finish',reason:{kind:'stop'}};}
  }
  ctx.llm.registerAdapter(providers,new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);
  const session=ctx.sessions.create('private-replay',{seed,meta:{cwd:home}}),agent={session,options:{provider:'apigo2',model:'glm-5.3-flash'}};
  const engine=new Engine(ctx,{auto:false}),before=ctx.tokenMeter.measure(session).totalTokens,nodes=[...session.surface.nodes];
  let error,result;
  try{result=await engine.compactIfNeeded(agent,'pressure',new AbortController().signal);}catch(e){error={code:e.code,message:e.message};}
  return {beforeTokens:before,afterTokens:ctx.tokenMeter.measure(session).totalTokens,calls,error,committed:!!result,
   originalSurfaceRetained:JSON.stringify(nodes)===JSON.stringify(session.surface.nodes),
   systemRetained:session.surface.nodes[0]===nodes[0],recentTailRetained:session.surface.nodes.at(-1)===nodes.at(-1),
   successfulSummaries:session.snapshotEvents().filter(e=>e.type==='compaction/summary').length};
 }finally{await ctx.fiber.dispose();if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;fs.rmSync(home,{recursive:true,force:true});}
}
const report={sourceSha256:hash(bytes),frames,sourceEventCount:events.length,replayEventCount:seed.length,
 old:await replay(Old),updated:await replay(BasicCompactionEngine),sourceUnchanged:hash(fs.readFileSync(source))===hash(bytes),
 externalProviderCalls:0,scope:'Actual historical transcript, fixed SDK transaction, controlled local adapter. Semantic summary quality and real upstream behavior require separate acceptance.'};
fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
