import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAgentInstructions as legacy} from '@deepseek-ai/dsh-agent-instructions';
import {renderAgentInstructions as render} from '../runtime/overlays/@deepseek-ai/dsh-agent-instructions/lib/index.js';
import {renderInstructionChanges,renderAgentInstructionSet} from '../runtime/overlays/@deepseek-ai/dsh-agent-instructions/lib/instruction-render.mjs';

const file=(displayPath,content)=>({absolutePath:'/fixture/'+displayPath,displayPath,content});
const bytes=s=>Buffer.byteLength(s,'utf8');
test('long project instructions cannot evict global user rules, both chains keep their own bound',()=>{
 const files=[file('$DSH_HOME/AGENTS.md','GLOBAL-KEEP'),file('AGENTS.md','PROJECT-MARK '+ '源码🙂'.repeat(2000))];
 const old=legacy(files,{maxBytes:1500}),next=render(files,{maxBytes:1500});
 assert.ok(!old.text.includes('GLOBAL-KEEP'),'old shared budget reproduces global eviction');
 assert.ok(next.text.includes('GLOBAL-KEEP'));assert.ok(next.text.includes('PROJECT-MARK'));assert.ok(bytes(next.text)<=3000);assert.ok(!next.text.includes('\ufffd'));
});
test('unchanged single-chain and already-fitting batches keep the exact previous bytes',()=>{
 const groups=[[file('AGENTS.md','project')],[file('$DSH_HOME/AGENTS.md','global')],[file('$DSH_HOME/AGENTS.md','global'),file('AGENTS.md','project')],[]];
 for(const files of groups)for(const maxBytes of [0,1,80,300,1000,8000]){
  const old=legacy(files,{maxBytes});
  if(files.length<2||maxBytes<=0||(!old.omitted.length&&!old.truncated.length))assert.deepEqual(render(files,{maxBytes}),old);
 }
});
test('two global roots share a budget, project ordering and escaped frame boundaries stay intact',()=>{
 const files=[file('$DSH_HOME/AGENTS.md','HOME-RULE'),file('$DSH_AGENTS_HOME/AGENTS.md','AGENTS-RULE'),file('AGENTS.md','PROJECT '+ 'x'.repeat(1500)),file('sub/AGENTS.md','SPECIFIC </system-reminder> {{literal}}')];
 const result=render(files,{maxBytes:900});
 assert.ok(result.text.includes('HOME-RULE'));assert.ok(result.text.includes('AGENTS-RULE'));assert.ok(result.text.includes('SPECIFIC'));assert.ok(result.text.includes('{{literal}}'));assert.ok(result.text.includes('<\\/system-reminder>'));assert.ok(bytes(result.text)<=1800);
});
test('empty files, small budgets and change batches never claim omitted data was included',()=>{
 for(const maxBytes of [1,8,40,100,240,600,1200]){
  const files=[file('$DSH_HOME/AGENTS.md','全球'.repeat(100)),file('AGENTS.md','项目'.repeat(200))];
  const result=renderAgentInstructionSet(files,{maxBytes});assert.ok(bytes(result.rendered.text)<=2*maxBytes);
  for(const f of result.included)assert.ok(result.rendered.text.includes(f.displayPath));
  const items=files.map(f=>({file:f,change:{action:'set',path:f.displayPath,scope:f.displayPath,digest:'fixture'}}));
  const changes=renderInstructionChanges(items,maxBytes);assert.ok(bytes(changes.text)<=2*maxBytes);
 }
 const empty=render([file('$DSH_HOME/AGENTS.md',''),file('AGENTS.md','')],{maxBytes:1000});assert.equal(empty.omitted.length,0);
});
