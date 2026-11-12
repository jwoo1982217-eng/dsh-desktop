import {deriveMetrics} from './metrics.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
export class MetricsReader{
 constructor(ctx){this.ctx=ctx;}
 async sessions(signal){const controller=this.ctx.get('sessionController');check(controller,'会话服务尚未就绪');const result=await controller.list({},signal);return result.items.map(s=>({id:s.sessionId,cwd:s.cwd||'',running:s.running,title:typeof s.projections?.values?.title==='string'?s.projections.values.title:s.sessionId}));}
 async read(id,limit=200,signal){
  check(typeof id==='string'&&id.length>0&&id.length<300,'会话ID无效');check(Number.isSafeInteger(limit)&&limit>=20&&limit<=1000,'读取窗口范围为20至1000条消息');
  const controller=this.ctx.get('sessionController');check(controller,'会话服务尚未就绪');
  const abort=new AbortController(),cancel=()=>abort.abort(signal.reason);if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const iterator=controller.follow({address:{kind:'session',sessionId:id},maxMessages:limit},abort.signal)[Symbol.asyncIterator]();
  let first;try{first=await iterator.next();check(first.value?.type==='snapshot','没有取得会话快照');}
  finally{abort.abort();await iterator.return?.();signal?.removeEventListener('abort',cancel);}
  const raw=first.value.records,capped=raw.length>20000,records=capped?raw.slice(-20000):raw;
  return{id,...deriveMetrics(records,{hasMore:first.value.hasMore,capped})};
 }
}
