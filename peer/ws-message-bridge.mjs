import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';

export const WS_MESSAGE_LIMIT = 8 * 1024 * 1024;
export const WS_QUEUE_LIMIT = 16 * 1024 * 1024;
export const WS_CHUNK_BYTES = 65536;
const LEGACY_LIMIT = 1024 * 1024;
const zip = promisify(gzip), unzip = promisify(gunzip);
export const wsOffer = () => ({chunks:true, maxMessageBytes:WS_MESSAGE_LIMIT, compression:'gzip', acknowledgedChunks:true});
export function wsCapabilities(value) {
  const chunks=value?.chunks===true;
  const advertised=value?.maxMessageBytes;
  const maxMessageBytes=chunks&&Number.isSafeInteger(advertised)&&advertised>=WS_CHUNK_BYTES
    ? Math.min(advertised,WS_MESSAGE_LIMIT) : LEGACY_LIMIT;
  return {chunks,maxMessageBytes,compression:chunks&&value?.compression==='gzip'?'gzip':undefined,acknowledgedChunks:chunks&&value?.acknowledgedChunks===true};
}
export function configureWs(ws,value) {
  const caps=wsCapabilities(value);
  ws.peerChunks=caps.chunks;ws.peerMessageBytes=caps.maxMessageBytes;ws.peerCompression=caps.compression;ws.peerAcknowledgedChunks=caps.acknowledgedChunks;
  return caps;
}

/** Bounded message assembly and per-socket ordered jobs. Idle sockets own no timers. */
export function createWsMessageBridge(tunnel) {
  const partials=new WeakMap(),sending=new WeakMap(),receiving=new WeakMap();
  let partialBytes=0;
  let inFlight=0;const waiters=[];
  async function transfer(packet,ws,q) {
    if(inFlight>=8)await new Promise(resolve=>waiters.push(resolve));else inFlight++;
    try{await writable(ws,q);await tunnel.call('ws.transfer',packet);}
    finally{const next=waiters.shift();if(next)next();else inFlight--;}
  }
  const limit=ws=>ws.peerMessageBytes??LEGACY_LIMIT;
  const live=ws=>{if(ws.readyState!==1||!tunnel.online)throw Error('Socket disconnected');};
  const clearPartial=ws=>{const p=partials.get(ws);if(p){partialBytes-=p.size;partials.delete(ws);}};
  function drop(ws) {
    clearPartial(ws);
    for(const jobs of [sending,receiving]){const q=jobs.get(ws);if(q)q.closed=true;jobs.delete(ws);}
  }
  function fail(ws,error){ws.peerTransferError=String(error?.message??'Socket transfer failed').slice(0,120);drop(ws);ws.terminate();}
  function queue(jobs,ws,size,job) {
    let q=jobs.get(ws);
    if(!q){q={bytes:0,tail:Promise.resolve(),closed:false};jobs.set(ws,q);}
    if(q.closed||q.bytes+size>WS_QUEUE_LIMIT)throw Error('Socket queue too large');
    q.bytes+=size;
    q.tail=q.tail.then(async()=>{if(q.closed)throw Error('Socket closed');if(jobs===sending){if(!tunnel.online)throw Error('Peer disconnected');}else live(ws);await job(q);})
      .catch(error=>fail(ws,error)).finally(()=>{q.bytes-=size;});
  }
  async function writable(ws,q) {
    let until=Date.now()+15000,previous=Infinity;
    while((tunnel.socket?.bufferedAmount??0)>1024*1024||(tunnel.bytes??0)>2*1024*1024){
      const backlog=(tunnel.socket?.bufferedAmount??0)+(tunnel.bytes??0);
      if(backlog<previous)until=Date.now()+15000;previous=backlog;
      if(!tunnel.online||q.closed||Date.now()>=until)throw Error('Socket transfer stalled');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    if(!tunnel.online||q.closed)throw Error('Socket closed');
  }
  function send(type,id,ws,data,binary) {
    if(data.length>limit(ws))throw Error('Socket message too large');
    queue(sending,ws,data.length,async q=>{
      let body=data,encoding;
      if(!binary&&ws.peerCompression==='gzip'&&data.length>=32768){
        const packed=await zip(data,{level:6});
        if(packed.length<data.length*0.9){body=packed;encoding='gzip';}
      }
      const metadata={binary:binary===true,...(encoding?{encoding,rawBytes:data.length}:{})};
      if(!ws.peerChunks||body.length<=WS_CHUNK_BYTES){
        await writable(ws,q);tunnel.send({type,id,...metadata,data:body.toString('base64')});return;
      }
      const jobs=new Set();
      try{
        for(let offset=0,index=0;offset<body.length;offset+=WS_CHUNK_BYTES,index++){
          const packet={type:type+'.chunk',id,...metadata,index,final:offset+WS_CHUNK_BYTES>=body.length,
            data:body.subarray(offset,offset+WS_CHUNK_BYTES).toString('base64')};
          if(!ws.peerAcknowledgedChunks){await writable(ws,q);tunnel.send(packet);continue;}
          const job=transfer(packet,ws,q);jobs.add(job);job.then(()=>jobs.delete(job),()=>{});
          if(jobs.size>=4)await Promise.race(jobs);
        }
        await Promise.all(jobs);
      }finally{await Promise.allSettled(jobs);}
    });
  }
  function receive(ws,m,chunked) {
    try {
      const max=limit(ws),encoding=m.encoding;
      if(encoding!==undefined&&(encoding!=='gzip'||ws.peerCompression!=='gzip'))throw Error('Socket encoding not negotiated');
      if(encoding&&( !Number.isSafeInteger(m.rawBytes)||m.rawBytes<0||m.rawBytes>max))throw Error('Socket expansion too large');
      if(!encoding&&m.rawBytes!==undefined)throw Error('Invalid socket encoding');
      if(typeof m.data!=='string'||m.data.length>Math.ceil((chunked?WS_CHUNK_BYTES:max)/3)*4)throw Error('Socket data too large');
      const bytes=Buffer.from(m.data,'base64');
      if(bytes.toString('base64')!==m.data)throw Error('Invalid socket data');
      let body=bytes,binary=m.binary===true;
      if(chunked){
        if(!ws.peerChunks||!Number.isInteger(m.index)||m.index<0||typeof m.final!=='boolean'||typeof m.binary!=='boolean'||bytes.length>WS_CHUNK_BYTES)throw Error('Invalid socket chunk');
        const prior=partials.get(ws);
        if(m.index!==(prior?.next??0)||(prior&&(m.binary!==prior.binary||encoding!==prior.encoding||m.rawBytes!==prior.rawBytes)))throw Error(`Socket chunk sequence changed: ${prior?.next??0}/${m.index}`);
        const p=prior??{next:0,size:0,parts:[],binary,encoding,rawBytes:m.rawBytes};
        if(p.size+bytes.length>max||p.next>=Math.ceil(max/WS_CHUNK_BYTES)||partialBytes+bytes.length>WS_QUEUE_LIMIT)throw Error('Socket assembly too large');
        p.next++;p.size+=bytes.length;p.parts.push(bytes);partialBytes+=bytes.length;partials.set(ws,p);
        if(!m.final)return true;
        body=Buffer.concat(p.parts,p.size);binary=p.binary;clearPartial(ws);
      }else if(partials.has(ws)||bytes.length>max)throw Error('Socket message interrupted');
      queue(receiving,ws,encoding?m.rawBytes:body.length,async q=>{
        const decoded=encoding?await unzip(body,{maxOutputLength:max}):body;
        if(encoding&&decoded.length!==m.rawBytes)throw Error('Socket expansion size mismatch');
        if(q.closed)throw Error('Socket closed');live(ws);
        await new Promise((resolve,reject)=>ws.send(decoded,{binary},error=>error?reject(error):resolve()));
      });
      return true;
    }catch(error){fail(ws,error);return false;}
  }
  const finish=(jobs,ws,callback)=>{
    const q=jobs.get(ws);
    void (q?.tail??Promise.resolve()).then(callback).catch(error=>fail(ws,error));
  };
  return {send,receive,drop,finishSend:(ws,callback)=>finish(sending,ws,callback),finishReceive:(ws,callback)=>finish(receiving,ws,callback)};
}
