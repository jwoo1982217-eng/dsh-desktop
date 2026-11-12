import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes, createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {PROBE_COMMAND,startCommand,logCommand,execute,createWebForward} from './remote.mjs';
const {Client} = createRequire(import.meta.url)('./vendor/node_modules/ssh2');

const fingerprint = key => 'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
const digest = text => createHash('sha256').update(text).digest('hex');
const idPattern=/^[a-f0-9]{24}$/;
const safeError = (code) => Object.assign(new Error(code),{code});
function check(value,code='INVALID_INPUT') {if(!value)throw safeError(code);}
function port(value, fallback) {const p=value??fallback;check(Number.isInteger(p)&&p>0&&p<=65535,'INVALID_PORT');return p;}
function config(input,id) {
  check(input&&typeof input==='object'&&!Array.isArray(input));
  const host=input.host;check(typeof host==='string'&&host.length<=253&&!/[\s\0/\\@?#%]/.test(host),'INVALID_HOST');
  check(net.isIP(host)!==0||(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)&&host.split('.').every(x=>x.length&&x.length<=63&&!x.startsWith('-')&&!x.endsWith('-'))),'INVALID_HOST');
  check(typeof input.username==='string'&&/^[a-zA-Z0-9_.@-]{1,128}$/.test(input.username)&&!input.username.startsWith('-'),'INVALID_USERNAME');
  check(typeof input.name==='string'&&input.name.trim().length>0&&input.name.length<=80&&!/[\0-\x1f]/.test(input.name),'INVALID_NAME');
  check(['password','key'].includes(input.auth),'INVALID_AUTH_METHOD');
  return {id,name:input.name.trim(),host:host.toLowerCase(),port:port(input.port,22),username:input.username,auth:input.auth,remotePort:port(input.remotePort,3080)};
}
function endpoint(p) {return JSON.stringify([p.host,p.port,p.username]);}
function rawAllowed(input,allowed) {check(input&&typeof input==='object'&&!Array.isArray(input));check(Object.keys(input).every(k=>allowed.includes(k)),'UNKNOWN_FIELD');}

export function createSshHosts({storageFile,credentials,clientFactory=()=>new Client(),handshakeTimeout=10000,webTimeout=8000,now=Date.now}={}) {
  check(typeof storageFile==='string'&&path.isAbsolute(storageFile),'STORAGE_REQUIRED');
  check(credentials&&['get','set','remove'].every(k=>typeof credentials[k]==='function'),'CREDENTIAL_STORE_REQUIRED');
  check(handshakeTimeout>=100&&handshakeTimeout<=60000&&webTimeout>=100&&webTimeout<=60000,'INVALID_TIMEOUT');
  let state={version:1,revision:0,hosts:[]}, fileHash=null, disposed=false, mutation=Promise.resolve();
  const proposals=new Map(), operations=new Map(), active=new Map();
  const ready=(async()=>{
    try {
      const stat=await fs.lstat(storageFile);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=262144,'INVALID_STORAGE');
      const text=await fs.readFile(storageFile,'utf8'),loaded=JSON.parse(text);
      check(loaded.version===1&&Number.isSafeInteger(loaded.revision)&&Array.isArray(loaded.hosts)&&loaded.hosts.length<=50,'INVALID_STORAGE');
      const ids=new Set();
      loaded.hosts=loaded.hosts.map(p=>{check(idPattern.test(p.id)&&!ids.has(p.id)&&Number.isSafeInteger(p.revision),'INVALID_STORAGE');ids.add(p.id);const clean=config(p,p.id);check(!p.fingerprint||/^SHA256:[a-zA-Z0-9+/]{43}$/.test(p.fingerprint),'INVALID_STORAGE');const refs={};for(const field of ['password','privateKey','passphrase','webToken'])if(p.refs?.[field]){check(p.refs[field].startsWith(`dsh-ssh/${p.id}/${field}/`)&&/^dsh-ssh\/[a-f0-9]{24}\/(password|privateKey|passphrase|webToken)\/[a-f0-9]{24}$/.test(p.refs[field]),'INVALID_STORAGE');refs[field]=p.refs[field];}return {...clean,revision:p.revision,refs,...p.fingerprint?{fingerprint:p.fingerprint}: {}};});
      state=loaded;fileHash=digest(text);
    } catch(error) {if(error.code!=='ENOENT')throw safeError('STORAGE_UNAVAILABLE');}
  })();
  async function ensure() {await ready;check(!disposed,'DISPOSED');}
  const serialize=fn=>{const task=mutation.then(fn,fn);mutation=task.catch(()=>{});return task;};
  async function persist(next) {
    await fs.mkdir(path.dirname(storageFile),{recursive:true,mode:0o700});
    const lock=storageFile+'.lock';let handle,temp;
    try {
      handle=await fs.open(lock,'wx',0o600);
      let current=null;try {const stat=await fs.lstat(storageFile);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=262144,'STORAGE_CHANGED');current=digest(await fs.readFile(storageFile));}catch(e){if(e.code!=='ENOENT')throw e;}
      check(current===fileHash,'STORAGE_CHANGED');
      const text=JSON.stringify(next,null,2)+'\n';check(Buffer.byteLength(text)<=262144,'STORAGE_LIMIT');
      temp=storageFile+'.'+randomBytes(12).toString('hex')+'.tmp';const fd=await fs.open(temp,'wx',0o600);
      try{await fd.writeFile(text);await fd.sync();}finally{await fd.close();}
      await fs.rename(temp,storageFile);temp=null;fileHash=digest(text);state=next;
    }catch(error){throw safeError(error.code==='EEXIST'?'STORAGE_BUSY':['STORAGE_CHANGED','STORAGE_LIMIT'].includes(error.code)?error.code:'STORAGE_WRITE_FAILED');}
    finally{if(temp)await fs.unlink(temp).catch(()=>{});if(handle){await handle.close();await fs.unlink(lock).catch(()=>{});}}
  }
  function find(id) {check(idPattern.test(id??''),'INVALID_ID');const p=state.hosts.find(p=>p.id===id);check(p,'HOST_NOT_FOUND');return p;}
  function view(p) {return {...config(p,p.id),revision:p.revision,fingerprint:p.fingerprint??null,hasPassword:!!p.refs.password,hasPrivateKey:!!p.refs.privateKey,hasPassphrase:!!p.refs.passphrase,hasWebToken:!!p.refs.webToken,status:operations.has(p.id)?'busy':active.has(p.id)?'connected':'disconnected'};}
  async function list() {await ensure();return {revision:state.revision,hosts:state.hosts.map(view)};}
  async function save(input) {
    await ensure();return serialize(async()=>{
      rawAllowed(input,['id','expectedRevision','name','host','port','username','auth','remotePort','secrets']);
      const old=input.id?find(input.id):null;check(!old||old.revision===input.expectedRevision,'STALE_REVISION');check(old||state.hosts.length<50,'HOST_LIMIT');
      const id=old?.id??randomBytes(12).toString('hex'),p=config(input,id),secrets=input.secrets??{};rawAllowed(secrets,['password','privateKey','passphrase','webToken']);
      const refs={...old?.refs},created=[];let committed=false;
      try{
        for(const [field,value]of Object.entries(secrets)){
          check(value===null||(typeof value==='string'&&value.length<=131072&&!value.includes('\0')),'INVALID_SECRET');
          if(value===null){delete refs[field];continue;}if(value==='')continue;
          const ref=`dsh-ssh/${id}/${field}/`+randomBytes(12).toString('hex');created.push(ref);await credentials.set(ref,value);refs[field]=ref;
        }
        if(p.auth==='password'){delete refs.privateKey;delete refs.passphrase;}else delete refs.password;
        check(p.auth==='password'?refs.password:refs.privateKey,'AUTH_SECRET_REQUIRED');
        const next={...p,refs,revision:(old?.revision??0)+1,...old?.fingerprint&&endpoint(old)===endpoint(p)?{fingerprint:old.fingerprint}:{}};
        await persist({...state,revision:state.revision+1,hosts:old?state.hosts.map(x=>x.id===id?next:x):[...state.hosts,next]});
        committed=true;
        if(old)await disconnect(id);
        for(const ref of Object.values(old?.refs??{}))if(!Object.values(refs).includes(ref))await Promise.resolve(credentials.remove(ref)).catch(()=>{});
        for(const ref of created)if(!Object.values(refs).includes(ref))await Promise.resolve(credentials.remove(ref)).catch(()=>{});
        return view(next);
      }catch(error){if(!committed)for(const ref of created)await Promise.resolve(credentials.remove(ref)).catch(()=>{});throw safeError(error.code??'CREDENTIAL_SAVE_FAILED');}
    });
  }
  async function remove(id,expectedRevision) {await ensure();return serialize(async()=>{const p=find(id);check(p.revision===expectedRevision,'STALE_REVISION');await persist({...state,revision:state.revision+1,hosts:state.hosts.filter(x=>x.id!==id)});await disconnect(id);for(const ref of Object.values(p.refs))await Promise.resolve(credentials.remove(ref)).catch(()=>{});return {removed:true};});}
  async function disconnect(id) {const op=operations.get(id);if(op){op.abort.abort();op.client?.destroy();}const live=active.get(id);active.delete(id);if(live){live.abort.abort();await live.forward.close();live.client.destroy();}return {disconnected:true};}
  async function acceptTrust({id,proposalToken,expectedRevision}) {await ensure();return serialize(async()=>{
    const p=find(id),proposal=proposals.get(proposalToken);proposals.delete(proposalToken);
    check(p.revision===expectedRevision,'STALE_REVISION');check(!p.fingerprint,'ALREADY_TRUSTED');check(proposal&&proposal.id===id&&proposal.until>=now()&&proposal.endpoint===endpoint(p)&&proposal.revision===p.revision,'TRUST_PROPOSAL_EXPIRED');
    const next={...p,revision:p.revision+1,fingerprint:proposal.fingerprint};await persist({...state,revision:state.revision+1,hosts:state.hosts.map(x=>x.id===id?next:x)});return view(next);
  });}
  async function forgetTrust({id,expectedRevision,fingerprint:confirmed}) {await ensure();return serialize(async()=>{const p=find(id);check(p.revision===expectedRevision&&p.fingerprint===confirmed,'STALE_REVISION');const next={...p,revision:p.revision+1};delete next.fingerprint;await persist({...state,revision:state.revision+1,hosts:state.hosts.map(x=>x.id===id?next:x)});await disconnect(id);return view(next);});}
  async function authenticate(p,op) {
    const key=p.auth==='password'?'password':'privateKey';const secret=await credentials.get(p.refs[key]);check(typeof secret==='string'&&secret.length,'CREDENTIAL_MISSING');
    const passphrase=p.refs.passphrase?await credentials.get(p.refs.passphrase):undefined;
    check(!op.abort.signal.aborted,'CANCELLED');const client=clientFactory();op.client=client;
    return new Promise((resolve,reject)=>{
      let settled=false,rejectedKey;
      const finish=(error)=>{if(settled)return;settled=true;op.abort.signal.removeEventListener('abort',abort);if(error){client.destroy();reject(error);}else resolve(client);};
      const abort=()=>finish(safeError('CANCELLED'));
      op.abort.signal.addEventListener('abort',abort,{once:true});
      client.on('error',error=>finish(rejectedKey??safeError(error.level==='client-authentication'?'AUTH_FAILED':'SSH_CONNECTION_FAILED')));
      client.once('close',()=>finish(rejectedKey??safeError('SSH_CONNECTION_CLOSED')));
      client.once('ready',()=>finish());
      const options={host:p.host,port:p.port,username:p.username,readyTimeout:handshakeTimeout,keepaliveInterval:0,tryKeyboard:false,authHandler:[p.auth==='password'?'password':'publickey'],hostVerifier:raw=>{
        const seen=fingerprint(raw);
        if(p.fingerprint===seen)return true;
        if(p.fingerprint){rejectedKey=Object.assign(safeError('HOST_KEY_CHANGED'),{expected:p.fingerprint,received:seen});return false;}
        for(const [token,v]of proposals)if(v.until<now())proposals.delete(token);if(proposals.size>=100)proposals.delete(proposals.keys().next().value);
        const proposalToken=randomBytes(24).toString('hex');proposals.set(proposalToken,{id:p.id,endpoint:endpoint(p),revision:p.revision,fingerprint:seen,until:now()+120000});
        const algorithm=raw.length>=4&&raw.readUInt32BE(0)<=64?raw.subarray(4,4+raw.readUInt32BE(0)).toString('ascii'):'unknown';
        rejectedKey=Object.assign(safeError('HOST_KEY_UNTRUSTED'),{fingerprint:seen,algorithm,proposalToken,revision:p.revision});return false;
      },[key]:secret,...p.auth==='key'&&passphrase?{passphrase}:{}};
      try{client.connect(options);}catch{finish(safeError('INVALID_AUTH_SECRET'));}
    });
  }
  async function run(id,action) {
    await ensure();const p=find(id);check(!operations.has(id),'OPERATION_BUSY');
    if(['connect','start'].includes(action)&&active.has(id))return {status:'connected',openUrl:active.get(id).forward.openUrl(),localAddress:active.get(id).forward.localAddress};
    const op={abort:new AbortController(),client:null};operations.set(id,op);let retained=false;
    try{
      const client=await authenticate(p,op),signal=op.abort.signal;
      let installed=false;
      try{installed=(await execute(client,PROBE_COMMAND,signal,handshakeTimeout)).includes('DSH_PRESENT');}catch(error){if(signal.aborted)throw error;}
      let webToken=p.refs.webToken?await credentials.get(p.refs.webToken):undefined;
      function logToken(log){const launch=[...log.matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s\r\n]+)/g)].at(-1);if(launch&&Number(launch[1])===p.remotePort){try{return decodeURIComponent(launch[2]);}catch{}}}
      if(!webToken&&installed){try{webToken=logToken(await execute(client,logCommand(p.id),signal,handshakeTimeout));}catch(error){if(signal.aborted)throw error;}}
      let forward;
      try{forward=await createWebForward({client,id:p.id,remotePort:p.remotePort,webToken,signal,timeout:webTimeout});}catch(error){
        if(signal.aborted)throw safeError('CANCELLED');
        if(action!=='start'||error.message==='REMOTE_WEB_AUTH_REQUIRED')return {status:error.message==='REMOTE_WEB_AUTH_REQUIRED'?'web-auth-required':installed?'not-running':'not-installed',installed};
        if(!installed)return {status:'not-installed',installed:false};
      }
      if(action==='start'&&!forward){
        await execute(client,startCommand(p.id,p.remotePort),signal,handshakeTimeout);
        const deadline=Date.now()+Math.min(20000,handshakeTimeout*2);
        while(Date.now()<deadline&&!signal.aborted){
          const log=await execute(client,logCommand(p.id),signal,handshakeTimeout);
          webToken=logToken(log)??webToken;
          try{forward=await createWebForward({client,id:p.id,remotePort:p.remotePort,webToken,signal,timeout:webTimeout});break;}catch(error){if(error.message==='REMOTE_WEB_AUTH_REQUIRED')return {status:'web-auth-required',installed};}
          await new Promise(resolve=>{const timer=setTimeout(done,250);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
        }
        if(!forward)return {status:'start-unconfirmed',installed};
      }
      check(!signal.aborted&&find(id).revision===p.revision,'CANCELLED');
      if(action==='test'){await forward.close();return {status:'ready',installed,webReachable:true};}
      const live={client,abort:op.abort,forward};active.set(id,live);retained=true;
      client.once('close',()=>{if(active.get(id)===live){active.delete(id);live.abort.abort();void forward.close();}});
      return {status:'connected',installed,openUrl:forward.openUrl(),localAddress:forward.localAddress};
    }catch(error){
      if(error.code==='HOST_KEY_UNTRUSTED')return {status:'trust-required',fingerprint:error.fingerprint,algorithm:error.algorithm,proposalToken:error.proposalToken,revision:error.revision};
      if(error.code==='HOST_KEY_CHANGED')return {status:'host-key-changed',expected:error.expected,received:error.received};
      throw safeError(op.abort.signal.aborted?'CANCELLED':error.code??error.message??'SSH_OPERATION_FAILED');
    }finally{if(operations.get(id)===op)operations.delete(id);if(!retained){op.abort.abort();op.client?.destroy();}}
  }
  async function manage(payload) {
    await ensure();check(payload&&typeof payload==='object');
    rawAllowed(payload,['action','host','id','expectedRevision','proposalToken','fingerprint']);
    switch(payload.action){
      case 'list':return list();
      case 'save':return save(payload.host);
      case 'remove':return remove(payload.id,payload.expectedRevision);
      case 'test':case 'connect':case 'start':return run(payload.id,payload.action);
      case 'trust':return acceptTrust(payload);
      case 'forget-trust':return forgetTrust(payload);
      case 'disconnect':case 'cancel':check(idPattern.test(payload.id??''),'INVALID_ID');return disconnect(payload.id);
      default:throw safeError('UNKNOWN_ACTION');
    }
  }
  async function dispose(){await ready;disposed=true;await Promise.all([...new Set([...active.keys(),...operations.keys()])].map(disconnect));proposals.clear();await mutation;}
  return {ready,list,save,remove,manage,disconnect,dispose};
}
