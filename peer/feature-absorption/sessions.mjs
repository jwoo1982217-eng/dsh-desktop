const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value)&&!value.startsWith('qq-')&&!value.startsWith('cloud-');
const titleOf=value=>typeof value==='string'?value:typeof value?.title==='string'?value.title:typeof value?.text==='string'?value.text:'';

/** Use the owning SDK's pure, current surface fold. Never export deleted raw audit messages. */
export function projectSessionForShare(source,{foldSurface,deriveEventMessage,projections=[]}={}){
  if(!source||!validId(source.id)||!Array.isArray(source.events)||source.events.length>100000)throw Error('会话记录不可读取或过大');
  if(typeof foldSurface!=='function'||typeof deriveEventMessage!=='function')throw Error('当前核心尚无安全的会话投影接口');
  const surface=foldSurface(source.events,projections),messages=[];
  for(const seq of surface.nodes){
    const event=source.events[seq];if(!event)throw Error('会话投影位置无效');
    if(event.type==='user/message'&&event.data?.source?.kind!=='user')continue;
    const message=deriveEventMessage(event,surface.projectedMessages);
    if(!message||!['user','assistant','tool'].includes(message.role)||!Array.isArray(message.content))continue;
    const blocks=[];
    for(const block of message.content){
      if(['text','reasoning'].includes(block.type)&&typeof block.text==='string')blocks.push({type:message.role==='tool'?'tool':block.type,text:block.text});
      else if(block.type==='tool-call')blocks.push({type:'tool',text:JSON.stringify({name:block.name,arguments:block.arguments??block.input??null})});
    }
    if(blocks.length)messages.push({seq,role:message.role,blocks,...Number.isSafeInteger(event.time)&&event.time>=0?{time:event.time}:{}});
  }
  return {id:source.id,title:titleOf(source.title)||source.id,messages};
}

export function createSessionReaders(ctx,{loadSdk=()=>import('@deepseek-ai/dsh-session')}={}){
  const controller=()=>ctx.get('sessionController');
  const readers={
    listSessions:async()=>{
      const service=controller();if(!service?.list)throw Error('当前环境尚未加载会话服务');
      const {items}=await service.list({});
      return items.filter(row=>validId(row.sessionId)).map(row=>({id:row.sessionId,
        title:titleOf(row.projections?.values?.title)||row.title||row.sessionId,updatedAt:row.updatedAt,running:row.running===true}));
    },
    readSession:async id=>{
      if(!validId(id))throw Error('仅支持普通本机会话');
      const service=controller();let observation;
      const read=async()=>{
        if(typeof service?.readSessionState==='function')return service.readSessionState(id);
        const query=ctx.get('sessionQuery');
        if(typeof query?.observeSession!=='function')throw Error('当前核心尚无只读会话接口');
        observation=await query.observeSession(id,{signal:AbortSignal.timeout(10000),projectionMode:'all'});
        return {id:observation.header?.id,header:observation.header,events:observation.events};
      };
      try {
      const source=await read(),sdk=await loadSdk();
      if(source.id!==id)throw Error('会话身份已变化');
      const session=ctx.get('sessions')?.get?.(id);
      const title=session?.header?.title??source.header?.title??(await readers.listSessions()).find(row=>row.id===id)?.title??id;
      return projectSessionForShare({...source,title},{foldSurface:sdk.foldSurface,deriveEventMessage:sdk.deriveEventMessage,projections:ctx.get('sessions')?.messageProjections??[]});
      } finally {observation?.[Symbol.dispose]?.();}
    },
  };
  return readers;
}
