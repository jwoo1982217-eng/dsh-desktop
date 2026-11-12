const hidden='[redacted]';
const sensitive=key=>/(?:password|passphrase|secret|token|apikey|authorization|cookie|credential|privatekey|paircode|invitation|prompt|message|conversation|transcript|sessionid|sessiontitle|draft)/i.test(key.replace(/[^a-z0-9]/gi,''))||/^(?:pair|room|content|env|args|command|home|cwd)$/i.test(key);
const secretAssignment=/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|secret|password|passphrase|authorization|cookie|密钥|密码)\s*[=:：]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi;
export function redactText(value,{knownSecrets=[]}={}){
 let text=String(value??'').replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g,hidden)
  .replace(/\bBearer\s+[^\s,;"'}]+/gi,'Bearer '+hidden)
  .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,hidden)
  .replace(secretAssignment,'$1'+hidden)
  .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,raw=>{try{const url=new URL(raw);return url.protocol+'//'+url.host+(url.pathname==='/'?'/':'/[path]');}catch{return '[url]';}})
  .replace(/\b[A-Z]:\\Users\\[^\\\s]+/gi,'[user]').replace(/\/(?:Users|home)\/[^/\s]+/g,'/[user]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]');
 for(const secret of knownSecrets.filter(x=>typeof x==='string'&&x.length>=6).slice(0,256))text=text.split(secret).join(hidden);
 return text;
}
/** Facts sources must already be allow-listed projections. Text/credential/session fields are removed again here. */
export function sanitizeFacts(value,{knownSecrets=[],maxBytes=65536}={}){
 let nodes=0,remaining=maxBytes;const seen=new WeakSet();
 const visit=(input,depth,key='')=>{
  if(sensitive(key))return typeof input==='boolean'?input:hidden;
  if(++nodes>2048||depth>8)return '[omitted: limit]';
  if(input===null||typeof input==='boolean')return input;
  if(typeof input==='number')return Number.isFinite(input)?input:null;
  if(typeof input==='string'){
   if(remaining<=0)return '[omitted: limit]';
   const text=redactText(input,{knownSecrets}).slice(0,1024),bytes=Buffer.from(text);const kept=bytes.subarray(0,Math.min(bytes.length,remaining)).toString('utf8').replace(/\uFFFD$/,'');remaining-=Buffer.byteLength(kept);return kept;
  }
  if(typeof input!=='object')return '[omitted]';
  if(Buffer.isBuffer(input)||ArrayBuffer.isView(input))return '[omitted: binary]';
  if(seen.has(input))return '[omitted: circular]';seen.add(input);
  if(Array.isArray(input))return input.slice(0,64).map(x=>visit(x,depth+1));
  const out=Object.create(null);
  for(const key of Object.keys(input).slice(0,64)){
   if(nodes>=2048)break;
   if(key==='__proto__'||key==='constructor'||key==='prototype')continue;
   const safeKey=redactText(key,{knownSecrets}).slice(0,80);
   try{out[safeKey]=visit(input[key],depth+1,key);}catch{out[safeKey]='[unavailable]';}
  }
  return out;
 };
 return visit(value,0);
}

const codes=/\b(?:PEER_[A-Z0-9_]{1,70}|ERR_[A-Z0-9_]{1,70}|E(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|NOTFOUND|PIPE|NOENT|ACCES|PERM|NOSPC|MFILE|NFILE)|SIG(?:KILL|TERM|ABRT|SEGV)|OOM|OutOfMemoryError|ENOSPC)\b/g;
const acceptedCodes=new Set(('PEER_JOIN_TIMEOUT PEER_HEARTBEAT_TIMEOUT PEER_DNS PEER_CONNECTION_REFUSED PEER_NETWORK PEER_HANDSHAKE_TIMEOUT PEER_PROTOCOL PEER_CLOSED PEER_PROXY_UNSUPPORTED PEER_PROXY_INVALID PEER_START_FAILED PEER_LAN_UNAVAILABLE PEER_LAN_DISCOVERY ERR_MODULE_NOT_FOUND ERR_INVALID_ARG_TYPE ERR_INVALID_ARG_VALUE ERR_HTTP_HEADERS_SENT ERR_STREAM_DESTROYED ERR_STREAM_PREMATURE_CLOSE ERR_SOCKET_CLOSED ERR_SSL_PROTOCOL_ERROR ERR_TLS_CERT_ALTNAME_INVALID ERR_OUT_OF_RANGE ERR_WORKER_OUT_OF_MEMORY ECONNRESET ECONNREFUSED ECONNABORTED ETIMEDOUT EHOSTUNREACH ENETUNREACH EAI_AGAIN ENOTFOUND EPIPE ENOENT EACCES EPERM ENOSPC EMFILE ENFILE SIGKILL SIGTERM SIGABRT SIGSEGV OOM OutOfMemoryError').split(' '));
/** Preserve technical log facts, never raw prompt, tool, API response or chat text. */
export function sanitizeLogs(value,{maxLines=200}={}){
 const lines=(Array.isArray(value)?value:typeof value==='string'?value.slice(-262144).split(/\r?\n/):[]).slice(-Math.min(2000,maxLines*10));
 const facts=[];let omitted=0;
 for(const line of lines){
  const text=typeof line==='string'?line.slice(0,8192):line&&typeof line==='object'?[line.at,line.level,line.code].filter(x=>typeof x==='string').join(' '):'';
  const found=[...new Set(text.match(codes)??[])].filter(x=>acceptedCodes.has(x)).slice(0,5);
  if(!found.length){omitted++;continue;}
  const at=text.match(/\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z?\b/)?.[0];
  const level=text.match(/\b(?:FATAL|ERROR|WARN|INFO|DEBUG)\b/i)?.[0].toUpperCase();
  facts.push([at,level,...found].filter(Boolean).join(' '));
 }
 return {lines:facts.slice(-Math.max(1,Math.min(maxLines,2000))),omittedLines:omitted,policy:'technical-codes-only; message and payload text omitted'};
}
