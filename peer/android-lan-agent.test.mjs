import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhysicalLanAgent,wifiInterface} from './android-lan-agent.mjs';

const interfaces=()=>({tun0:[{address:'172.19.0.1',netmask:'255.255.255.252'}],wlan0:[{address:'192.168.50.11',netmask:'255.255.255.0'}]});
const endpoint=new URL('http://192.168.50.22:12345/relay');
test('Wi-Fi selection excludes VPN interfaces, loopback, public and another subnet',()=>{
 assert.equal(wifiInterface(endpoint.hostname,interfaces()),'wlan0');
 for(const host of ['172.19.0.2','127.0.0.1','8.8.8.8','192.168.30.2','computer.local','::1'])assert.equal(wifiInterface(host,interfaces()),undefined);
 assert.equal(wifiInterface('192.168.50.22',{wlan0:[{address:'192.168.50.11',netmask:'0.0.0.0'}]}),undefined);
 assert.equal(wifiInterface('203.0.113.20',{wlan0:[{address:'203.0.113.10',netmask:'255.255.255.0'}]}),undefined);
});
test('other platforms, ABIs, TLS and public carriers retain their original agent',()=>{
 const loadAddon=()=>{throw Error('Must not load native code')};
 for(const option of [{platform:'darwin',arch:'arm64'},{platform:'android',arch:'x64'}])assert.equal(createPhysicalLanAgent(endpoint,{...option,interfaces,loadAddon}),null);
 for(const url of ['https://192.168.50.22/','http://8.8.8.8/','http://127.0.0.1/'])assert.equal(createPhysicalLanAgent(new URL(url),{platform:'android',arch:'arm64',interfaces,loadAddon}),null);
});
test('a missing native helper leaves existing relay and direct fallback available',()=>{
 assert.equal(createPhysicalLanAgent(endpoint,{platform:'android',arch:'arm64',interfaces,loadAddon:()=>{throw Error('not installed')}}),null);
});
test('a Wi-Fi carrier owns one descriptor and connects only to its original endpoint',()=>{
 const opened=[],connected=[],closed=[];
 const agent=createPhysicalLanAgent(endpoint,{platform:'android',arch:'arm64',interfaces,loadAddon:()=>({openWifiSocket:name=>(opened.push(name),42)}),socket:options=>({connect:target=>connected.push({options,target}),destroy(){}}),close:fd=>closed.push(fd)});
 const result=agent.createConnection({host:endpoint.hostname,port:12345},()=>assert.fail('unexpected failure'));
 assert.ok(result);assert.deepEqual(opened,['wlan0']);assert.deepEqual(connected,[{options:{fd:42},target:{host:endpoint.hostname,port:12345,family:4}}]);assert.deepEqual(closed,[]);agent.destroy();
});
test('constructor failure closes the unowned descriptor and rejects just that connection',async()=>{
 const closed=[];const agent=createPhysicalLanAgent(endpoint,{platform:'android',arch:'arm64',interfaces,loadAddon:()=>({openWifiSocket:()=>43}),socket:()=>{throw Error('constructor failed')},close:fd=>closed.push(fd)});
 const error=await new Promise(resolve=>agent.createConnection({host:endpoint.hostname,port:12345},resolve));assert.match(error.message,/constructor/);assert.deepEqual(closed,[43]);agent.destroy();
});
test('reusing an agent for another destination cannot open or bind a socket',async()=>{
 let opens=0;const agent=createPhysicalLanAgent(endpoint,{platform:'android',arch:'arm64',interfaces,loadAddon:()=>({openWifiSocket:()=>++opens})});
 const error=await new Promise(resolve=>agent.createConnection({host:'8.8.8.8',port:12345},resolve));assert.match(error.message,/target changed/);assert.equal(opens,0);agent.destroy();
});
