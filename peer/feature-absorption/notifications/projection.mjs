// Browser-safe projection of the installed alpha.1 durable event/follow protocol.
// No message bodies, tool arguments, answers, credentials or raw request ids leave this module.
const sequence=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=256;
export function classifySessionEvent(event){
 if(!event||!sequence(event.seq)||typeof event.data!=='object'||event.data===null)return null;
 if(event.type==='approval/asked')return 'approval';
 if(event.type==='tool/call'&&event.data.name==='ask_user_question')return 'question';
 if(event.type==='tool/ptc-dispatch'&&event.data.name==='ask_user_question'&&event.data.isError!==true&&pendingResult(event.data.content))return 'question';
 if(event.type==='turn/end'){
  switch(event.data.reason?.kind){
   case 'completed':return 'completed';
   case 'error':case 'blocked':return 'failed';
   case 'aborted':case 'interrupted':case 'max-tokens':return 'stopped';
   // forked is inherited history; unknown/new endings never become success.
   default:return null;
  }
 }
 return null;
}
function pendingResult(content){
 if(!Array.isArray(content))return false;
 const block=content.find(x=>x?.type==='text');if(typeof block?.text!=='string'||block.text.length>65536)return false;
 try{return JSON.parse(block.text)?.pending===true;}catch{return false;}
}
function snapshotActive(frame){
 const rows=Array.isArray(frame.records)?frame.records:[];
 for(let i=rows.length-1;i>=Math.max(0,rows.length-2048);i--){const event=rows[i]?.type==='event'?rows[i].event:null;if(event?.type==='turn/end'||event?.type==='session/end-seed')return false;if(event?.type==='turn/start')return true;}
 return null;
}
/** One projector per followed Session/stream; the only retained raw ids are bounded pending-call keys. */
export function createSessionFrameProjector(){
 const pending=new Map();let hasWork=null,lastSequence=-1;
 const observeEvent=event=>{
  if(!event||!sequence(event.seq)||typeof event.type!=='string')return null;
  if(event.seq<=lastSequence)return null;lastSequence=event.seq;
  const result={type:'event',seq:event.seq},kind=classifySessionEvent(event);if(kind)result.kind=kind;
  if(event.type==='turn/start'){result.active=true;hasWork=false;}
  if(event.type==='step/start'){result.active=true;hasWork=true;}
  if(event.type==='turn/end'){
   result.active=false;
   const continued=[...pending.values()].filter(x=>x.kind==='question'&&x.continued);
   if(result.kind==='completed'&&(continued.length||hasWork===false))delete result.kind;
   if(!continued.length){result.clearAttention=true;pending.clear();}
   else for(const [key,item]of pending)if(!item.continued){(result.settles??=[]).push(item.seq);pending.delete(key);}
   hasWork=null;
  }
  if(event.type==='session/end-seed'){result.active=false;result.clearAttention=true;pending.clear();hasWork=null;}
  const data=event.data??{};
  const remember=(prefix,id,kind)=>{if(!opaque(id))return;const key=prefix+id;pending.delete(key);pending.set(key,{seq:event.seq,kind,continued:false});while(pending.size>128)pending.delete(pending.keys().next().value);};
  const settle=(prefix,id)=>{if(!opaque(id))return;const key=prefix+id,item=pending.get(key);if(item!==undefined){pending.delete(key);(result.settles??=[]).push(item.seq);}};
  if(event.type==='approval/asked')remember('approval:',data.id,'approval');
  if(event.type==='approval/decided')settle('approval:',data.id);
  if(event.type==='tool/call'&&data.name==='ask_user_question')remember('question:',data.callId,'question');
  if(event.type==='tool/ptc-dispatch'&&kind==='question'){remember('question:',data.subCallId,'question');const item=pending.get('question:'+data.subCallId);if(item)item.continued=true;}
  if(event.type==='tool/result'){
   const item=pending.get('question:'+data.message?.toolCallId);
   if(item&&(pendingResult(data.message?.content)||data.error?.code==='TOOL_OUTCOME_UNKNOWN'))item.continued=true;
   else settle('question:',data.message?.toolCallId);
  }
  if(event.type==='user/message'&&data.source?.kind==='user-question-reply')settle('question:',data.source.callId);
  return kind||result.active!==undefined||result.settles?.length||result.clearAttention?result:null;
 };
 const observeFrame=frame=>{
  if(frame?.type==='snapshot'){
   if(!Number.isSafeInteger(frame.cursor)||frame.cursor< -1||frame.cursor>=Number.MAX_SAFE_INTEGER)return null;
   if(frame.cursor<lastSequence)return null;lastSequence=frame.cursor;
   pending.clear();hasWork=null;
   const records=Array.isArray(frame.records)?frame.records:[];
   for(let i=records.length-1;i>=Math.max(0,records.length-2048);i--){const event=records[i]?.type==='event'?records[i].event:null;if(event?.type==='step/start'){hasWork=true;break;}if(event?.type==='turn/start'){hasWork=false;break;}if(event?.type==='turn/end'||event?.type==='session/end-seed')break;}
   return {type:'snapshot',cursor:frame.cursor,active:snapshotActive(frame)};
  }
  return frame?.type==='event'?observeEvent(frame.event):null;
 };
 return {observeFrame,observeEvent,reset:(through=-1)=>{pending.clear();hasWork=null;lastSequence=Number.isSafeInteger(through)&&through>= -1&&through<Number.MAX_SAFE_INTEGER?through:-1;}};
}
