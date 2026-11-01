import {test} from 'node:test';
import assert from 'node:assert/strict';
import relay from './worker.mjs';

test('failed room access stays closed and logs no room, proof, URL or bearer secret', async () => {
  const room='a'.repeat(32), proof='b'.repeat(64), secret='secret_'+ 'x'.repeat(40), rows=[];
  const old=console.error; console.error=(...args)=>rows.push(args);
  try {
    const result=await relay.fetch(new Request(`https://relay.example/relay?room=${room}`,{headers:{Upgrade:'websocket',Authorization:`Bearer ${proof}`}}),{
      ROOMS:{idFromName:()=>room,get:()=>({fetch:()=>{throw Error(`storage temporarily unavailable room=${room} proof=${proof} https://private.example/${secret} Bearer ${secret}`)}})}
    });
    assert.equal(result.status,503);assert.equal(await result.text(),'unavailable');
    assert.equal(rows.length,1);const text=JSON.stringify(rows);
    assert.match(text,/storage temporarily unavailable/);
    for(const sensitive of [room,proof,secret,'private.example'])assert.ok(!text.includes(sensitive));
  } finally {console.error=old;}
});
