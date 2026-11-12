import {randomUUID} from 'node:crypto';

/** Change only read-only session followers; prompts, approvals and other mux streams pass unchanged. */
export function createQuietSessionBridge({send,quietAfterMs=30000,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const streams=new Map(),wire=new Map(),retired=new Set();
  let hidden=false,away=false,timer,closed=false;
  const decode=(data,binary)=>{if(binary)return;try{const value=JSON.parse(data.toString());return value&&typeof value==='object'?value:undefined;}catch{}};
  const retire=id=>{wire.delete(id);retired.add(id);if(retired.size>256)retired.delete(retired.values().next().value);};
  const forget=state=>{streams.delete(state.browserId);retire(state.wireId);};
  const encode=(message,original)=>Buffer.isBuffer(original)?Buffer.from(JSON.stringify(message)):JSON.stringify(message);
  function rotate(state,quiet){
    if(closed||state.quiet===quiet)return;
    const previous=state.wireId,next=randomUUID();
    const request={...state.open.payload.args.request,assistantStream:!quiet};
    const opening={...state.open,streamId:next,payload:{...state.open.payload,args:{...state.open.payload.args,request}}};
    // Fresh ids avoid closing the SDK client's original logical stream or replaying an uplink operation.
    send({type:'cancel',streamId:previous});retire(previous);
    state.wireId=next;state.quiet=quiet;wire.set(next,state);
    send(opening);
  }
  function quietRunning(){if(hidden&&away&&!closed)for(const state of streams.values())if(state.running)rotate(state,true);}
  function running(state,value){
    const events=value?.type==='snapshot'?value.records?.map(row=>row.event):value?.type==='event'?[value.event]:[];
    for(const event of events??[]){if(event?.type==='turn/start')state.running=true;else if(event?.type==='turn/end')state.running=false;}
    if(state.running&&hidden&&away&&!state.quiet)queueMicrotask(quietRunning);
  }
  return {
    uplink(data,binary=false){
      if(closed)return data;
      const message=decode(data,binary);if(!message||typeof message.streamId!=='string')return data;
      let state=streams.get(message.streamId);
      if(message.type==='open'&&message.endpoint==='session/follow'&&message.payload?.args?.request?.assistantStream===true){
        if(state)return encode({...message,streamId:state.wireId},data);
        if(streams.size>=16)return data;
        state={browserId:message.streamId,wireId:message.streamId,open:message,quiet:false,running:false};
        streams.set(message.streamId,state);wire.set(message.streamId,state);return data;
      }
      if(!state)return data;
      const result=state.wireId===message.streamId?data:encode({...message,streamId:state.wireId},data);
      if(message.type==='cancel')forget(state);
      return result;
    },
    downlink(data,binary=false){
      if(closed)return data;
      const message=decode(data,binary);if(!message||typeof message.streamId!=='string')return data;
      if(retired.has(message.streamId))return null;
      const state=wire.get(message.streamId);if(!state)return data;
      running(state,message.value);
      let modified=state.wireId!==state.browserId;
      if(state.quiet&&message.type==='item'&&message.value?.type==='snapshot'&&message.value.assistantStream===undefined){
        // Older browser SDKs require an explicit empty opening baseline even when token frames are disabled.
        message.value={...message.value,assistantStream:{revision:0}};modified=true;
      }
      if(modified)message.streamId=state.browserId;
      if(['end','error'].includes(message.type))forget(state);
      return modified?encode(message,data):data;
    },
    visibility(value){
      if(typeof value!=='boolean')throw Error('Invalid page visibility');
      if(closed||hidden===value)return {supported:true,hidden};
      hidden=value;clearTimer(timer);timer=undefined;away=false;
      if(hidden){timer=setTimer(()=>{timer=undefined;away=true;quietRunning();},quietAfterMs);timer.unref?.();}
      else for(const state of streams.values())if(state.quiet)rotate(state,false);
      return {supported:true,hidden};
    },
    status:()=>({hidden,away,streams:streams.size,quiet:[...streams.values()].filter(row=>row.quiet).length,observedAt:now()}),
    close(){closed=true;clearTimer(timer);timer=undefined;streams.clear();wire.clear();retired.clear();},
  };
}
