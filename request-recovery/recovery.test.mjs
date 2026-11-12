import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetryHandoff} from './recovery.mjs';
import {createUserMessage} from '../desktop-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

const old = {provider:'zcode', model:'glm-old'};
const next = {provider:'taotokenplan', model:'glm-5.3-flash'};
const header = route => ({type:'request/header', data:{header:{config:route}}});
const selected = route => ({type:'model/selection', data:route});
const retry = provider => ({type:'llm/retry', data:{provider}});
function fixture() {
  const pending = [], calls = [], inbox = [{id:'pending-user-message'}];
  const session = {id:'fixture-session', log:[]};
  const agent = {session, status:'running', cancel(cause, options) { calls.push({kind:'cancel',cause,options}); }, followup(message) { calls.push({kind:'followup',message}); inbox.push(message); }};
  let root = true;
  const recovery = createRetryHandoff({getAgent:() => agent, isRoot:() => root, createMessage:createUserMessage, schedule:fn=>pending.push(fn)});
  const emit = (...events) => { for(const event of events) { session.log.push(event); recovery.observe(session,event); } };
  return {agent, session, calls, inbox, recovery, emit, flush:()=>{while(pending.length)pending.shift()();}, child:()=>{root=false;}};
}

test('observed ZCode retry → APIGO → GLM: cancel once and continue on latest selection, retain inbox', () => {
  const f=fixture();
  f.emit(header(old),retry('zcode'),selected({provider:'apigo',model:'deepseek-flash'}),selected(next),selected(next));
  assert.equal(f.calls.length,0);f.flush();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].kind,'cancel');
  assert.equal(f.calls[0].options.keepInbox,true);assert.equal(f.inbox[0].id,'pending-user-message');
  const message=f.calls[1].message;assert.equal(message.source.kind,'model-selection');assert.equal(message.role,'user');
  assert.match(message.content[0].text,/taotokenplan\/glm-5.3-flash/);assert.match(message.content[0].text,/do not repeat/);
  assert.equal(f.recovery.status().handoffs,1);
  f.emit(selected(next));f.flush();assert.equal(f.calls.length,2);
});
test('healthy stream and tool execution are never cancelled by selecting another API', () => {
  const f=fixture();f.emit(header(old),selected(next));f.flush();assert.equal(f.calls.length,0);
  f.emit(retry('zcode'),{type:'assistant/message',data:{}},{type:'tool/call',data:{name:'bash'}});f.flush();assert.equal(f.calls.length,0);
});
test('selection made before a failed response takes effect when retry is announced', () => {
  const f=fixture();f.emit(header(old),selected(next));f.flush();f.emit(retry('zcode'));f.flush();assert.equal(f.calls.length,2);
});
test('same model selection or reasoning-only change does not restart', () => {
  const f=fixture();f.emit(header(old),retry('zcode'),selected({...old,reasoningEffort:'low'}));f.flush();assert.equal(f.calls.length,0);
});
test('selection reverted before handoff leaves request alone', () => {
  const f=fixture();f.emit(header(old),retry('zcode'),selected(next),selected(old));f.flush();assert.equal(f.calls.length,0);
});
test('successful completion/new step wins the race with cancellation', () => {
  for(const type of ['step/end','step/start','turn/end','assistant/message']){
    const f=fixture();f.emit(header(old),retry('zcode'),selected(next),{type,data:{}});f.flush();assert.equal(f.calls.length,0,type);
  }
});
test('never wake an idle or child agent', () => {
  for(const mode of ['idle','child']){const f=fixture();f.emit(header(old),retry('zcode'),selected(next));if(mode==='idle')f.agent.status='idle';else f.child();f.flush();assert.equal(f.calls.length,0);}
});
test('loading during the real failed-retry state recovers once; cold historical ended work stays idle', () => {
  const f=fixture();f.session.log=[header(old),retry('zcode'),selected(next)];f.recovery.seed(f.session);f.flush();assert.equal(f.calls.length,2);
  const g=fixture();g.session.log=[header(old),retry('zcode'),selected(next),{type:'turn/end',data:{}}];g.recovery.seed(g.session);g.flush();assert.equal(g.calls.length,0);
});
test('a fresh request header retires old selection; retries on another provider are ignored', () => {
  const f=fixture();f.emit(header(old),selected(next),header(next),retry('taotokenplan'));f.flush();assert.equal(f.calls.length,0);
  const g=fixture();g.emit(header(old),retry('other-provider'),selected(next));g.flush();assert.equal(g.calls.length,0);
});
test('disposal or rollback prevents a scheduled handoff', () => {
  for(const close of [f=>f.recovery.close(),f=>f.recovery.forget(f.session)]){const f=fixture();f.emit(header(old),retry('zcode'),selected(next));close(f);f.flush();assert.equal(f.calls.length,0);}
});
test('an already attached idle session needs no new header event after plugin activation', () => {
  const f=fixture();f.session.requestHeader=()=>({config:old});f.emit(retry('zcode'),selected(next));f.flush();assert.equal(f.calls.length,2);
});
test('failed inbox writes are contained instead of crashing the host or repeating cancellation', () => {
  const f=fixture();f.agent.followup=()=>{throw Error('disposed during handoff');};
  f.emit(header(old),retry('zcode'),selected(next));assert.doesNotThrow(f.flush);
  assert.equal(f.recovery.status().failures,1);assert.equal(f.recovery.status().handoffs,0);
  f.emit(selected(next));f.flush();assert.equal(f.calls.length,1);
});
