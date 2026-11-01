import {mkdir,readFile,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createRelay} from '../peer/relay.mjs';
import landing from '../remote-relay/worker.mjs';
const ROOM=/^[a-f0-9]{32}$/, PROOF=/^[a-f0-9]{64}$/;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const bearer=req=>typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
const send=(res,status,text='denied')=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(text)};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>512)throw Object.assign(Error('oversized body'),{status:413});chunks.push(chunk)}return Buffer.concat(chunks)}
async function save(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';let file;try{file=await open(temp,'wx',0o600);await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=null;await rename(temp,path)}finally{await file?.close();await unlink(temp).catch(()=>{})}}
export async function createFixedRelay({adminKey,admissionsFile,androidCertSha256,maxRooms=100}){
 if(typeof adminKey!=='string'||adminKey.length<16||adminKey.length>4096||/\s/.test(adminKey)||!admissionsFile)throw Error('Fixed relay configuration invalid');
 let admissions={};try{admissions=JSON.parse(await readFile(admissionsFile,'utf8'));if(!admissions||Array.isArray(admissions)||Object.keys(admissions).length>maxRooms||Object.entries(admissions).some(([id,v])=>!ROOM.test(id)||!PROOF.test(v?.proof)||typeof v.revoked!=='boolean'))throw Error('Fixed relay admission data invalid')}catch(e){if(e.code!=='ENOENT')throw e}
 let mutation=Promise.resolve(),closed=false;let relay;
 const update=async fn=>{const op=mutation.then(async()=>{const next={...admissions};const result=fn(next);if(result.changed){await save(admissionsFile,next);admissions=next}return result});mutation=op.catch(()=>{});return op};
 relay=createRelay({maxRooms,
  admit(req){const url=new URL(req.url,'http://relay.internal');const room=url.searchParams.get('room');const admission=admissions[room];if(req.method!=='GET'||url.pathname!=='/relay'||[...url.searchParams.keys()].join(',')!=='room'||!ROOM.test(room||'')||!admission||admission.revoked||!equal(bearer(req),admission.proof))return null;return{room,proof:admission.proof}},
  async handleRequest(req,res){
   const url=new URL(req.url,'http://relay.internal');
   if(['/health','/connect','/.well-known/assetlinks.json'].includes(url.pathname)){
    const result=await landing.fetch(new Request('http://relay.internal'+url.pathname,{method:req.method}),{ANDROID_CERT_SHA256:androidCertSha256});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;
   }
   const registration=url.pathname==='/admin/rooms', removal=/^\/admin\/rooms\/([a-f0-9]{32})$/.exec(url.pathname);
   if(!registration&&!removal){send(res,url.pathname==='/relay'?426:404);return}
   if(url.search||req.method!==(registration?'POST':'DELETE')){send(res,405);return}
   if(!equal(bearer(req),adminKey)){send(res,401);return}
   const length=req.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>(registration?512:0))){send(res,413);return}
   let bytes;try{bytes=await body(req)}catch(e){send(res,e.status||503);return}
   if(removal){if(bytes.length){send(res,413);return}const room=removal[1];await update(next=>{if(!next[room])return{changed:false};next[room]={...next[room],revoked:true};return{changed:true}});relay.dropRoom(room);send(res,200,'ok');return}
   if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'){send(res,400);return}
   let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{send(res,400);return}
   if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='proof,room'||!ROOM.test(value.room||'')||!PROOF.test(value.proof||'')){send(res,400);return}
   const result=await update(next=>{const old=next[value.room];if(old&&!equal(old.proof,value.proof))return{status:409,changed:false};if(old&&!old.revoked)return{status:200,changed:false};if(!old&&Object.keys(next).length>=maxRooms)return{status:429,changed:false};next[value.room]={proof:value.proof,revoked:false};return{status:old?200:201,changed:true}});
   send(res,result.status,result.status===409?'conflict':result.status===429?'busy':'ok');
  }
 });
 return{...relay,async close(){if(closed)return;closed=true;await mutation;await relay.close()}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const config=JSON.parse(await readFile(process.argv[2],'utf8'));
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('Invalid port');
  const relay=await createFixedRelay({...config,adminKey:(await readFile(config.adminKeyFile,'utf8')).trim()});
  await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(config.port,'127.0.0.1',resolve)});
  console.log('DSH fixed relay ready');
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await relay.close();process.exit(0)};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
 }catch{console.error('DSH fixed relay could not start');process.exit(1)}
}
