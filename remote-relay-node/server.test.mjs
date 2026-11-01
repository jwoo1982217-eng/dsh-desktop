import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createFixedRelay} from './server.mjs';
const admin='synthetic-test-admin-key-no-real-credentials', room='1'.repeat(32), proof='2'.repeat(64);
const wait=(ws,event)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('relay event timeout')),3000);ws.once(event,(...v)=>{clearTimeout(timer);resolve(v)});ws.once('error',reject)});
const message=ws=>wait(ws,'message').then(v=>v[0].toString());
async function client(base,role,token=proof){const ws=new WebSocket(base.replace('http:','ws:')+'/relay?room='+room,{headers:{Authorization:'Bearer '+token}});ws.on('error',()=>{});await wait(ws,'open');const ack=message(ws);ws.send(JSON.stringify({type:'join',room,proof:token,role}));assert.equal(await ack,'{"type":"joined"}');return ws;}

test('persistent fixed relay authenticates before upgrade, forwards opaque messages, reconnects and revokes',async()=>{
 const dir=await mkdtemp(join(process.env.RELAY_TEST_ARTIFACTS||tmpdir(),'fixed-relay-'));const file=join(dir,'admissions.json');let relay;const sockets=[];
 const start=async()=>{relay=await createFixedRelay({adminKey:admin,admissionsFile:file});await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+relay.server.address().port;};
 let base=await start();
 const api=(path,method='GET',body,key=admin)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 const rejected=async token=>{const ws=new WebSocket(base.replace('http:','ws:')+'/relay?room='+room,{headers:{Authorization:'Bearer '+token}});ws.on('error',()=>{});const [status]=await new Promise(resolve=>ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve([res.statusCode])}));assert.equal(status,403)};
 try{
  assert.equal((await api('/health')).status,200);
  assert.equal((await api('/admin/rooms','POST',{room,proof},'invalid')).status,401);
  await rejected(proof);
  assert.equal((await api('/admin/rooms','POST',{room,proof})).status,201);
  assert.equal((await api('/admin/rooms','POST',{room,proof})).status,200);
  assert.equal((await api('/admin/rooms','POST',{room,proof:'3'.repeat(64)})).status,409);
  await rejected('3'.repeat(64));
  const computer=await client(base,'computer');sockets.push(computer);const online=message(computer);const phone=await client(base,'phone');sockets.push(phone);assert.equal(await online,'{"type":"peer-online"}');
  const payload='opaque-encrypted-fixture';const receive=message(computer);phone.send(payload);assert.equal(await receive,payload);
  await relay.close();base=await start();
  const reComputer=await client(base,'computer');sockets.push(reComputer);const reOnline=message(reComputer);const rePhone=await client(base,'phone');sockets.push(rePhone);await reOnline;
  const received=message(reComputer);rePhone.send(payload);assert.equal(await received,payload);
  const closed=wait(reComputer,'close');assert.equal((await api('/admin/rooms/'+room,'DELETE')).status,200);await closed;await rejected(proof);
  assert.ok(!String(await readFile(file)).includes(admin));
  await relay.close();base=await start();await rejected(proof);
 }finally{for(const ws of sockets)ws.terminate();await relay?.close();await rm(dir,{recursive:true,force:true})}
});

test('revocation also closes an admitted socket that has not joined yet',async()=>{
 const dir=await mkdtemp(join(process.env.RELAY_TEST_ARTIFACTS||tmpdir(),'fixed-pending-'));const relay=await createFixedRelay({adminKey:admin,admissionsFile:join(dir,'rooms.json')});let ws;
 try{await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+relay.server.address().port;
 const init={headers:{Authorization:'Bearer '+admin,'content-type':'application/json'}};
 await fetch(base+'/admin/rooms',{...init,method:'POST',body:JSON.stringify({room,proof})});
 ws=new WebSocket(base.replace('http:','ws:')+'/relay?room='+room,{headers:{Authorization:'Bearer '+proof}});ws.on('error',()=>{});await wait(ws,'open');const closed=wait(ws,'close');
 assert.equal((await fetch(base+'/admin/rooms/'+room,{...init,method:'DELETE'})).status,200);await closed;assert.equal(relay.rooms.size,0);
 }finally{ws?.terminate();await relay.close();await rm(dir,{recursive:true,force:true})}
});

test('corrupt persisted admission data fails closed without replacing the recovery input',async()=>{
 const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(process.env.RELAY_TEST_ARTIFACTS||tmpdir(),'fixed-corrupt-'));const file=join(dir,'rooms.json');const original='{"not-valid":"fixture"}';await writeFile(file,original);
 try{await assert.rejects(createFixedRelay({adminKey:admin,admissionsFile:file}));assert.equal(await readFile(file,'utf8'),original)}finally{await rm(dir,{recursive:true,force:true})}
});
