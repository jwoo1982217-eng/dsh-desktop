import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {PROBE_COMMAND} from './remote.mjs';
const {Server,utils}=createRequire(import.meta.url)('./vendor/node_modules/ssh2');

export const fixturePassword='fixture-only-password';
export const fixtureToken='fixture-only-web-token';
export const fixturePassphrase='fixture-only-passphrase';
export const keys=()=>utils.generateKeyPairSync('ed25519');
export const encryptedKeys=()=>utils.generateKeyPairSync('ed25519',{passphrase:fixturePassphrase,cipher:'aes256-cbc',rounds:16});

export function memoryCredentials(){const data=new Map();return {data,get:ref=>data.get(ref),set:(ref,value)=>{data.set(ref,value);},remove:ref=>{data.delete(ref);}};}

export async function fixture({hostKey=keys(),userKey=keys(),port=0,installed=true,authDelay=0,webCookie='fixture-remote-only',notStarted=false}={}) {
  const clients=new Set(),sockets=new Set(),observed={authAttempts:0,commands:[],forwards:[],requests:[],connections:0};
  let requireToken=true,started=false;
  const web=http.createServer(async(req,res)=>{
    observed.requests.push({path:req.url,headers:{...req.headers}});
    if(notStarted){res.writeHead(503).end('DSH not yet started');return;}
    if(req.url==='/?token='+fixtureToken){res.writeHead(302,{'set-cookie':`remote_session=${webCookie}; HttpOnly; SameSite=Strict; Path=/`,'location':'/'}).end();return;}
    if(requireToken&&!req.headers.cookie?.includes('remote_session='+webCookie)){res.writeHead(401).end('Authentication required');return;}
    if(req.url==='/bytes'){const chunks=[];for await(const b of req)chunks.push(b);res.writeHead(200,{'content-type':'application/octet-stream'}).end(Buffer.concat(chunks));return;}
    if(req.url==='/headers'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(req.headers));return;}
    res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>SSH fixture</title><p id="ready">target ready</p><script>window.remoteCookie=document.cookie;window.ws=new WebSocket(location.origin.replace("http:","ws:")+"/ws");ws.onopen=()=>ws.send("fixture-ws");ws.onmessage=e=>window.wsResult=e.data;</script>');
  });
  web.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  web.on('upgrade',(req,socket)=>{
    observed.requests.push({path:req.url,headers:{...req.headers}});
    if(!req.headers.cookie?.includes('remote_session='+webCookie)){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.on('data',data=>{if((data[0]&15)!==1)return;let length=data[1]&127,offset=2;if(length===126){length=data.readUInt16BE(2);offset=4;}if(length>1000||data.length<offset+4+length)return;const mask=data.subarray(offset,offset+4);offset+=4;const body=Buffer.from(data.subarray(offset,offset+length));for(let i=0;i<body.length;i++)body[i]^=mask[i%4];socket.write(Buffer.concat([Buffer.from([0x81,body.length]),body]));});
    socket.on('error',()=>{});
  });
  await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  const remotePort=web.address().port,allowed=utils.parseKey(userKey.public);
  const server=new Server({hostKeys:[hostKey.private]},client=>{
    observed.connections++;clients.add(client);let alive=true;const authTimers=new Set();client.on('error',()=>{});client.once('close',()=>{alive=false;clients.delete(client);for(const timer of authTimers)clearTimeout(timer);});
    client.on('authentication',ctx=>{
      observed.authAttempts++;
      const good=ctx.username==='fixture'&&(ctx.method==='password'&&ctx.password===fixturePassword||ctx.method==='publickey'&&ctx.key.data.equals(allowed.getPublicSSH())&&(!ctx.signature||allowed.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true));
      if(authDelay){const timer=setTimeout(()=>{authTimers.delete(timer);if(alive)good?ctx.accept():ctx.reject();},authDelay);authTimers.add(timer);}else good?ctx.accept():ctx.reject();
    });
    client.on('ready',()=>{
      client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
        observed.commands.push(info.command);const channel=accept();let output;
        if(info.command===PROBE_COMMAND)output=installed?'DSH_PRESENT\n':'DSH_MISSING\n';
        else if(info.command.includes('tail -c 32768'))output=started?`dsh web: http://127.0.0.1:${remotePort}/?token=${fixtureToken}\n`:'';
        else if(info.command.includes('nohup dsh web')){started=true;notStarted=false;output='DSH_START_REQUESTED\n';}
        else {channel.exit(1);channel.end();return;}
        channel.write(output);channel.exit(0);channel.end();
      }));
      client.on('tcpip',(accept,reject,info)=>{
        observed.forwards.push(info);if(info.destIP!=='127.0.0.1'||info.destPort!==remotePort){reject();return;}
        const socket=net.connect(remotePort,'127.0.0.1');sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>reject());socket.once('connect',()=>{const stream=accept();stream.on('error',()=>socket.destroy());socket.on('error',()=>stream.destroy());stream.pipe(socket).pipe(stream);stream.on('close',()=>socket.destroy());});
      });
    });
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  return {port:server.address().port,remotePort,hostKey,userKey,observed,setRequireToken:value=>{requireToken=value;},close:async()=>{for(const c of clients)c.end();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>web.close(r))]);}};
}
