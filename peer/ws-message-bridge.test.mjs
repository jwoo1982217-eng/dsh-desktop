import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {gzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import WebSocket,{WebSocketServer} from 'ws';
import {configureWs,wsCapabilities,wsOffer,createWsMessageBridge,WS_MESSAGE_LIMIT} from './ws-message-bridge.mjs';

const wait=async fn=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('Expected message did not arrive');await new Promise(r=>setTimeout(r,5));}};
async function fixture(t){
 const server=createServer(),sockets=new WebSocketServer({server});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const accepted=once(sockets,'connection'),browser=new WebSocket(`ws://127.0.0.1:${server.address().port}`);
 browser.on('error',()=>{});await once(browser,'open');const [ws]=await accepted;
 const tunnel=new EventEmitter();Object.assign(tunnel,{online:true,socket:{bufferedAmount:0},bytes:0,rows:[],send(m){this.rows.push(m)}});
 const bridge=createWsMessageBridge(tunnel);configureWs(ws,wsOffer());
 t.after(async()=>{bridge.drop(ws);browser.terminate();for(const s of sockets.clients)s.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));});
 return {browser,ws,tunnel,bridge};
}
test('capability negotiation retains the old limit and disables compression for old peers',()=>{
 assert.deepEqual(wsCapabilities({chunks:true}),{chunks:true,maxMessageBytes:1024*1024,compression:undefined,acknowledgedChunks:false});
 assert.equal(wsCapabilities({chunks:true,maxMessageBytes:Infinity,compression:'unknown'}).maxMessageBytes,1024*1024);
 assert.equal(wsCapabilities({...wsOffer(),maxMessageBytes:32*1024*1024}).maxMessageBytes,WS_MESSAGE_LIMIT);
 assert.equal(wsCapabilities({chunks:false,...wsOffer(),chunks:false}).compression,undefined);
});
test('a compressible history uses fewer wire bytes and decodes before the next message',async t=>{
 const {browser,ws,tunnel,bridge}=await fixture(t),messages=[];browser.on('message',x=>messages.push(x.toString()));
 const body=Buffer.from(JSON.stringify({text:'真实历史内容😀'.repeat(100000)}));
 bridge.send('ws.data','one',ws,body,false);bridge.send('ws.data','one',ws,Buffer.from('next'),false);
 await wait(()=>tunnel.rows.some(x=>x.data===Buffer.from('next').toString('base64')));
 assert.ok(tunnel.rows[0].encoding==='gzip');assert.ok(tunnel.rows.reduce((n,x)=>n+Buffer.byteLength(x.data),0)<body.length/5);
 for(const row of tunnel.rows)bridge.receive(ws,row,row.type.endsWith('.chunk'));
 await wait(()=>messages.length===2);assert.deepEqual(messages,[body.toString(),'next']);
});
test('a gzip bomb closes just its socket and never delivers expanded bytes',async t=>{
 const {browser,ws,bridge}=await fixture(t),messages=[];browser.on('message',x=>messages.push(x));
 const closed=once(browser,'close'),packed=gzipSync(Buffer.alloc(WS_MESSAGE_LIMIT+1,65));
 bridge.receive(ws,{type:'ws.data',data:packed.toString('base64'),binary:false,encoding:'gzip',rawBytes:WS_MESSAGE_LIMIT},false);
 await closed;assert.equal(messages.length,0);
});
test('messages above the negotiated byte limit are rejected before enqueueing',async t=>{
 const {ws,tunnel,bridge}=await fixture(t);configureWs(ws,{chunks:true});
 assert.throws(()=>bridge.send('ws.data','too-large',ws,Buffer.alloc(1024*1024+1),false),/too large/);
 assert.equal(tunnel.rows.length,0);assert.equal(tunnel.online,true);
 bridge.send('ws.data','valid',ws,Buffer.from('still works'),false);await wait(()=>tunnel.rows.length===1);
});
test('closing a socket while its transport is congested prevents delayed transmission',async t=>{
 const {ws,tunnel,bridge}=await fixture(t);tunnel.socket.bufferedAmount=2*1024*1024;
 bridge.send('ws.data','cancelled',ws,Buffer.from('never send'),false);bridge.drop(ws);ws.terminate();
 tunnel.socket.bufferedAmount=0;await new Promise(r=>setTimeout(r,30));assert.equal(tunnel.rows.length,0);
});
test('fragment metadata changes are rejected without delivering an incomplete message',async t=>{
 const {browser,ws,bridge}=await fixture(t),messages=[];browser.on('message',x=>messages.push(x));
 const closed=once(browser,'close');
 bridge.receive(ws,{index:0,final:false,binary:false,data:'YWJj'},true);
 bridge.receive(ws,{index:1,final:true,binary:true,data:'ZA=='},true);
 await closed;assert.equal(messages.length,0);
});
