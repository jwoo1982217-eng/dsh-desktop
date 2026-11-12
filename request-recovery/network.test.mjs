import test from 'node:test';
import assert from 'node:assert/strict';
import {bypassFailedLocalProxy} from './network.mjs';
import {proxyRouteFor,installProxyFromEnvironment} from '../desktop-runtime/node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js';
test('actual SDK routes bypass broken localhost proxy, retain loopback bypass, and restore original policy',async()=>{
 const values={HTTP_PROXY:'http://127.0.0.1:1082',HTTPS_PROXY:'http://127.0.0.1:1082',NO_PROXY:'example.local'};
 const old=await installProxyFromEnvironment({get:key=>values[key]===undefined?undefined:{value:values[key]}},()=>{});
 try{
  assert.equal(proxyRouteFor(new URL('https://api.apigoto.com')).proxied,true);
  const change=await bypassFailedLocalProxy({routeFor:proxyRouteFor,install:installProxyFromEnvironment,env:values});
  assert.equal(change.applied,true);assert.equal(proxyRouteFor(new URL('https://api.apigoto.com')).proxied,false);assert.equal(proxyRouteFor(new URL('http://127.0.0.1:3080')).proxied,false);
  await change.restore();assert.equal(proxyRouteFor(new URL('https://api.apigoto.com')).proxied,true);
 }finally{await old();}
});
test('do not alter another proxy or an already-direct route',async()=>{
 for(const route of [{proxied:false},{proxied:true,proxy:'http://remote.example:1082'}]){
  const result=await bypassFailedLocalProxy({routeFor:()=>route,install:()=>{throw Error('must not install');}});assert.equal(result.applied,false);
 }
});
