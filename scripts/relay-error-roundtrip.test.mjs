import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
const modules=process.env.DSH_RELAY_RUNTIME??path.join(root,'desktop-runtime/node_modules');
const {createUserMessage}=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh-llm/lib/index.js')));
const gatewaySource=process.env.DSH_RELAY_RUNTIME?path.join(modules,'dsh-codearts-auth/lib/openai-gateway/server.js'):path.join(root,'vendor/dsh-codearts-auth/lib/openai-gateway/server.js');
const {createOpenAiGateway}=await import(pathToFileURL(gatewaySource));
const report=process.argv[2]??path.join(os.tmpdir(),'dsh-relay-errors');await mkdir(report,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-relay-errors-'));
const modulePath=path.join(modules,'@deepseek-ai/dsh-llm-pi-ai/lib/.error-qa-'+randomUUID()+'.mjs');
const source=await readFile(process.env.DSH_RELAY_SOURCE??path.join(root,'runtime/overlays/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8');
await writeFile(modulePath,source+'\nexport {resolveProfiles,mapStopReason};\n');let sdk;try{sdk=await import(pathToFileURL(modulePath));}finally{await rm(modulePath);}
// 可选回放生产会话中提取的脱敏失败；不发送旧对话内容到云端。
const observedFile=process.env.DSH_RELAY_OBSERVED_ERRORS;
const observed=observedFile?JSON.parse(await readFile(observedFile,'utf8')).failures:[];
const replayResults=[];
for(const failure of observed){
 const reason=sdk.mapStopReason({stopReason:'error',model:'fixture-model',content:[],errorMessage:failure.message},65536);
 const body=JSON.parse(failure.message.slice(5)),detail=body.error??body;
 assert.equal(reason.failure.code,'UPSTREAM_RESTRICTED');assert.equal(reason.failure.status,403);assert.equal(reason.failure.message,detail.message);
 replayResults.push({index:failure.index,oldCode:failure.code,newCode:reason.failure.code,status:403,message:reason.failure.message});
}
let mode='credits',calls=0;const seen=[];
const upstream=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 assert.equal(req.headers.authorization,'Bearer local-fixture-key');assert.equal(body.model,'fixture-model');calls++;
 const bodies={credits:{status:429,body:{error:{message:'Credits不足，请充值或开启自动兑换',type:'gateway_error',code:'42907'}}},monthly:{status:429,body:{message:'本月订阅外消费额度已达上限',type:'gateway_error',code:'42906'}},rate:{status:429,body:{error:{message:'请求频率过高',type:'gateway_error',code:'42905'}}},restricted:{status:403,body:{message:'请求内容已多次触发上游风控，该客户端已被暂时限制调用（约 1 分钟后自动解除）',type:'gateway_error',code:'40303'}},restrictedNested:{status:403,body:{error:{message:'请稍后再试（约 10 分钟后自动解除）',type:'gateway_error',code:40303}}},auth:{status:401,body:{error:{message:'api key not found',type:'gateway_error',code:'40101'}}},forbidden:{status:403,body:{error:{message:'当前模型未获授权',type:'gateway_error',code:'40203'}}},unknown:{status:429,body:{error:{message:'unknown condition',type:'other_vendor_error',code:'42907'}}}};
 if(mode!=='ok'){const x=bodies[mode];res.writeHead(x.status,{'content-type':'application/json'});res.end(JSON.stringify(x.body));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const c={id:'local-qa',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{role:'assistant',content:'43'},finish_reason:null}]};
 res.write('data: '+JSON.stringify(c)+'\n\n');res.write('data: '+JSON.stringify({...c,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const profiles=sdk.resolveProfiles({fixture:{api:'openai-completions',baseURL:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKeyEnv:'QA_KEY',models:[{id:'fixture-model'}]}});
const adapter=new sdk.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=> 'local-fixture-key'});
const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Compute 17 + 26. Output the number only.'}]})];
const llm={listProviders:()=>[{id:'fixture'}],listModels:()=>adapter.listModels('fixture'),resolveModelInfo:(p,m)=>adapter.resolveModel(p,m),async *stream(options){for await(const chunk of adapter.stream(options)){if(chunk.type==='finish')seen.push({mode,...chunk.reason});yield chunk;}}};
const portProbe=createServer();const port=await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',()=>{const p=portProbe.address().port;portProbe.close(()=>resolve(p));}));
const gateway=createOpenAiGateway({llm,home:temp,env:{DSH_OPENAI_GATEWAY_PORT:String(port),DSH_OPENAI_GATEWAY_API_KEY:'local-gateway-fixture'},logger:{info(){},warn(){},error(){}}});
const results=[];
try{
 await gateway.start();
 for(const [current,code,status,type]of [['credits','QUOTA',429,'insufficient_quota'],['monthly','QUOTA',429,'insufficient_quota'],['rate','RATE_LIMIT',429,'rate_limit_error'],['restricted','UPSTREAM_RESTRICTED',403,'gateway_error'],['restrictedNested','UPSTREAM_RESTRICTED',403,'gateway_error'],['auth','AUTH',401,'authentication_error'],['forbidden','AUTH',403,'authentication_error'],['unknown','RATE_LIMIT',429,'rate_limit_error']]){
  mode=current;
  for(const protocol of ['chat/completions','responses']){
   const before=calls;
   const payload=protocol==='responses'?{model:'fixture/fixture-model',input:'Compute 17 + 26',max_output_tokens:32}:{model:'fixture/fixture-model',messages:[{role:'user',content:'Compute 17 + 26'}],max_tokens:32};
   const r=await fetch('http://127.0.0.1:'+port+'/v1/'+protocol,{method:'POST',headers:{authorization:'Bearer local-gateway-fixture','content-type':'application/json'},body:JSON.stringify(payload)});const body=await r.json();
   assert.equal(r.status,status,current+'/'+protocol);assert.equal(body.error.code,code);assert.equal(body.error.type,type);assert.equal(seen.at(-1).failure.status,status);assert.equal(calls-before,1);
   const policy=adapter.providerRetryPolicy('fixture');assert.equal(policy.retryableCodes.includes(code),code==='RATE_LIMIT');results.push({mode,protocol,status,code,type,calls:1});
  }
 }
 // 流式 HTTP 已发 200 时，错误事件仍须保留业务状态和失败终态。
 for(const [current,status,code]of [['credits',429,'QUOTA'],['forbidden',403,'AUTH'],['restricted',403,'UPSTREAM_RESTRICTED']]){
  mode=current;
  for(const protocol of ['chat/completions','responses']){
   const body=protocol==='responses'?{model:'fixture/fixture-model',input:'Compute 17 + 26',stream:true}:{model:'fixture/fixture-model',messages:[{role:'user',content:'Compute 17 + 26'}],stream:true};
   const r=await fetch('http://127.0.0.1:'+port+'/v1/'+protocol,{method:'POST',headers:{authorization:'Bearer local-gateway-fixture','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);
   const text=await r.text();const events=text.split('\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));const error=protocol==='responses'?events.find(x=>x.type==='response.failed')?.response?.error:events.find(x=>x.error)?.error;
   assert.equal(error?.status,status);assert.equal(protocol==='responses'?error.dsh_code:error.code,code);if(protocol==='responses')assert.ok(!events.some(x=>x.type==='response.completed'));
   results.push({mode,protocol,stream:true,errorStatus:error.status,code});
  }
 }
 // 只有已观察到的 403/gateway_error/40303 才认临时限制，其他鉴权错误维持原行为。
 for(const errorMessage of ['403: not json','403: {"type":"other","code":"40303"}','403: {"type":"gateway_error","code":"40304"}','401: {"type":"gateway_error","code":"40303"}']){
  const reason=sdk.mapStopReason({stopReason:'error',model:'fixture-model',content:[],errorMessage},65536);assert.equal(reason.failure.code,'AUTH');
 }
 // 格式损坏、无来源状态、相同数字但不同错误结构均不能猜成额度耗尽。
 for(const errorMessage of ['429: not json','429: {"type":"other","code":"42907"}','network failed after 42907 bytes']){
  const reason=sdk.mapStopReason({stopReason:'error',model:'fixture-model',content:[],errorMessage},65536);assert.notEqual(reason.failure.code,'QUOTA');
 }
 mode='ok';const chunks=[];for await(const c of adapter.stream({provider:'fixture',model:'fixture-model',messages,maxTokens:32,signal:AbortSignal.timeout(10000)}))chunks.push(c);
 assert.equal(chunks.filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'43');assert.equal(chunks.at(-1).reason.kind,'stop');
 const verification={actualPiAiAdapter:true,actualHttpUpstream:true,actualHttpGateway:true,loopbackOnly:true,cloudCalls:0,quotaNotRetryable:true,temporaryRestrictionNotRetryable:true,restrictionMessagePreserved:true,transientRateLimitRetryable:true,authStatusPreserved:true,bothProtocols:true,unknownErrorsNotGuessed:true,recoveryAfterFailure:true,observedFailureReplay:replayResults,cases:results};
 await writeFile(path.join(report,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));
}finally{await gateway.close();await new Promise(resolve=>upstream.close(resolve));await rm(temp,{recursive:true,force:true});}
