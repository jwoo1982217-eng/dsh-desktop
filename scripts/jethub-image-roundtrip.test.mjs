import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {Context} from '../desktop-runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import {LocalAttachmentStore} from '../desktop-runtime/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';
import {createUserMessage,assertUsableApiKey} from '../desktop-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import {createOpenAiGateway} from '../vendor/dsh-codearts-auth/lib/openai-gateway/server.js';
const root=fileURLToPath(new URL('../',import.meta.url));const report=process.argv[2]??path.join(os.tmpdir(),'dsh-jethub-roundtrip');await mkdir(report,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-jethub-roundtrip-'));
const modulePath=path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/.roundtrip-'+randomUUID()+'.mjs');
const source=await readFile(path.join(root,'runtime/overlays/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8');await writeFile(modulePath,source+'\nexport {resolveProfiles,discoverModels};\n');let sdk;try{sdk=await import(pathToFileURL(modulePath));}finally{await rm(modulePath);}
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return out;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32);ihdr.writeUInt32BE(32,4);ihdr[8]=8;ihdr[9]=2;
const scan=Buffer.concat(Array.from({length:32},()=>Buffer.concat([Buffer.from([0]),Buffer.from(Array.from({length:32},()=>[51,136,204]).flat())])));
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
const ctx=new Context(),attachments=new LocalAttachmentStore(ctx,{dshHome:temp});const original=await attachments.saveImage({data:png,mediaType:'image/png'});const seen=[];
const llm={listProviders:()=>[{id:'fixture'}],async listModels(){return[{provider:'fixture',id:'vision/with-slash',name:'本地图片模型'}];},async resolveModelInfo(provider,model){assert.equal(provider,'fixture');assert.equal(model,'vision/with-slash');return{provider,id:model,name:'本地图片模型',inputModalities:['text','image'],context:{contextWindow:65536},defaultMaxTokens:4096};},async *stream(options){const refs=options.messages.flatMap(m=>m.content).filter(b=>b.type==='image').map(b=>b.attachment);for(const ref of refs){assert.equal(ref.width,32);assert.equal(ref.height,32);const stored=await attachments.readImage(ref);assert.ok(stored.data.length>0);}seen.push({provider:options.provider,model:options.model,images:refs.length});yield{type:'text-delta',index:0,text:'本地图片已收到'};yield{type:'finish',reason:{kind:'stop'}};}};
const probe=createServer();const port=await new Promise(resolve=>probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));}));
const apiKey='local-roundtrip-fixture-key',baseURL='http://127.0.0.1:'+port+'/v1';
const gateway=createOpenAiGateway({llm,attachments,home:temp,env:{DSH_OPENAI_GATEWAY_PORT:String(port),DSH_OPENAI_GATEWAY_API_KEY:apiKey},logger:{info(){},warn(){},error(){}}});
try{
 await gateway.start();
 const discovered=await sdk.discoverModels({provider:'local-relay',api:'openai-completions',baseURL,apiKey:'  '+apiKey+'  '});assert.equal(discovered[0].id,'fixture/vision/with-slash');assert.deepEqual(discovered[0].inputModalities,['text','image']);
 let key=apiKey;const make=models=>{const profiles=sdk.resolveProfiles({'imported-jethub':{api:'openai-completions',baseURL,apiKeyEnv:'QA_API_KEY',models}});return new sdk.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async(provider,profile)=>{assert.equal(provider,'imported-jethub');assert.equal(profile.apiKeyEnv,'QA_API_KEY');return assertUsableApiKey('  '+key+'  ','llm-pi-ai',profile.apiKeyEnv);},resolveAttachments:()=>attachments});};
 const legacy=make([{id:discovered[0].id,input:[]}]);assert.deepEqual((await legacy.resolveModel('imported-jethub',discovered[0].id)).inputModalities,['text']);
 const adapter=make(discovered.map(m=>({id:m.id,input:m.inputModalities})));assert.deepEqual((await adapter.resolveModel('imported-jethub',discovered[0].id)).inputModalities,['text','image']);
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:original},{type:'text',text:'本地图片链路验收'}]})];
 const result=[];for await(const value of adapter.stream({provider:'imported-jethub',model:discovered[0].id,messages,signal:AbortSignal.timeout(15000),maxTokens:16}))result.push(value);
 assert.equal(seen.length,1);assert.equal(seen[0].images,1);assert.equal(seen[0].model,'vision/with-slash');assert.ok(result.some(x=>x.type==='text-delta'&&x.text.includes('图片已收到')));
 // Responses 与 Chat 共用入站图片转换，真实附件服务必须拿到图片引用。
 const dataURL='data:image/png;base64,'+png.toString('base64');const response=await fetch(baseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify({model:discovered[0].id,input:[{role:'user',content:[{type:'input_image',image_url:dataURL}]}],stream:false})});assert.equal(response.status,200);await response.json();assert.equal(seen[1].images,1);
 // 错密钥与坏图片必须在本地网关拒绝，不进入模型；恢复后仍能发送。
 const before=seen.length;const bad=await fetch(baseURL+'/chat/completions',{method:'POST',headers:{authorization:'Bearer wrong-fixture-key','content-type':'application/json'},body:JSON.stringify({model:discovered[0].id,messages:[{role:'user',content:'不应到达模型'}]})});assert.equal(bad.status,401);await bad.arrayBuffer();assert.equal(seen.length,before);
 const malformed=await fetch(baseURL+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify({model:discovered[0].id,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]}]})});assert.equal(malformed.status,400);await malformed.arrayBuffer();assert.equal(seen.length,before);
 const recovered=[];for await(const value of adapter.stream({provider:'imported-jethub',model:discovered[0].id,messages,signal:AbortSignal.timeout(15000),maxTokens:16}))recovered.push(value);assert.equal(seen.length,before+1);
 const verification={actualPiAiAdapter:true,actualAttachmentStore:true,actualHttpGateway:true,loopbackOnly:true,cloudCalls:0,fullModelIdPreserved:true,discoveredImageCapability:true,oldMissingCapabilityReproduced:true,chatImageDelivered:seen[0].images===1,responsesImageDelivered:seen[1].images===1,correctBearerKeyAccepted:true,wrongKeyRejected:bad.status===401,malformedImageRejected:malformed.status===400,recoveredAfterFailures:seen.at(-1).images===1};await writeFile(path.join(report,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));
}finally{await gateway.close();await rm(temp,{recursive:true,force:true});}
