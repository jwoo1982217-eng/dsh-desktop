import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuietSessionBridge} from './quiet-session-bridge.mjs';
const open=id=>({type:'open',streamId:id,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:'session-fixture'},assistantStream:true,maxMessages:200}}}});
const snapshot=(id,running=true)=>({type:'item',streamId:id,value:{type:'snapshot',cursor:4,records:[{event:{type:running?'turn/start':'turn/end'}}],assistantStream:{revision:7}}});
const bytes=x=>Buffer.from(JSON.stringify(x));
function fixture(){let fire;const sent=[],cancelled=[];const bridge=createQuietSessionBridge({send:x=>sent.push(x),setTimer:fn=>(fire=fn,{unref(){}}),clearTimer:x=>cancelled.push(x)});return {bridge,sent,cancelled,fire:()=>fire()};}
test('hidden remote running follower drops token opt-in only after the deadline, retains durable stream identity and restores a fresh baseline',()=>{
 const {bridge,sent,fire}=fixture(),request=bytes(open('browser-one'));assert.equal(bridge.uplink(request),request);bridge.downlink(bytes(snapshot('browser-one')));
 bridge.visibility(true);assert.equal(sent.length,0);fire();assert.equal(sent.length,2);assert.equal(sent[0].type,'cancel');assert.equal(sent[1].payload.args.request.assistantStream,false);
 const wire=sent[1].streamId;assert.notEqual(wire,'browser-one');assert.equal(bridge.downlink(bytes({type:'end',streamId:'browser-one'})),null);
 const quiet=snapshot(wire);delete quiet.value.assistantStream;const frame=JSON.parse(bridge.downlink(bytes(quiet)));assert.equal(frame.streamId,'browser-one');assert.deepEqual(frame.value.assistantStream,{revision:0});
 const durable={type:'item',streamId:wire,value:{type:'event',event:{type:'tool/approval',seq:5}}};assert.deepEqual(JSON.parse(bridge.downlink(bytes(durable))).value,durable.value);
 bridge.visibility(false);assert.equal(sent.length,4);assert.equal(sent[3].payload.args.request.assistantStream,true);
 const current=snapshot(sent[3].streamId);assert.equal(JSON.parse(bridge.downlink(bytes(current))).value.assistantStream.revision,7);bridge.close();
});
test('prompts, event callbacks, binary packets and idle followers are never replayed or changed',()=>{
 const {bridge,sent,fire}=fixture();const prompt=bytes({type:'open',streamId:'prompt',endpoint:'session/prompt',payload:{args:{request:{text:'private'}}}});
 assert.equal(bridge.uplink(prompt),prompt);const binary=Buffer.from([0,1,2]);assert.equal(bridge.uplink(binary,true),binary);
 const read=bytes(open('idle'));bridge.uplink(read);bridge.downlink(bytes(snapshot('idle',false)));bridge.visibility(true);fire();assert.equal(sent.length,0);bridge.visibility(false);bridge.close();
});
test('a cancelled follower or closed transport cannot be reopened by the hidden deadline',()=>{
 const {bridge,sent,fire}=fixture();bridge.uplink(bytes(open('one')));bridge.downlink(bytes(snapshot('one')));bridge.visibility(true);bridge.uplink(bytes({type:'cancel',streamId:'one'}));fire();assert.equal(sent.length,0);bridge.close();fire();assert.equal(sent.length,0);
});
test('cancellation addresses only the replacement follower; foreground does not resurrect it',()=>{
 const {bridge,sent,fire}=fixture();bridge.uplink(bytes(open('one')));bridge.downlink(bytes(snapshot('one')));bridge.visibility(true);fire();const id=sent[1].streamId;
 assert.deepEqual(JSON.parse(bridge.uplink(bytes({type:'cancel',streamId:'one'}))),{type:'cancel',streamId:id});bridge.visibility(false);assert.equal(sent.length,2);assert.equal(bridge.status().streams,0);bridge.close();
});
