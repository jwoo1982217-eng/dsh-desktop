import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

export function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('INVALID_SHELL_VALUE');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export const PROBE_COMMAND = "if command -v dsh >/dev/null 2>&1; then printf 'DSH_PRESENT\\n'; else printf 'DSH_MISSING\\n'; fi";

export function startCommand(id, port) {
  if (!/^[a-f0-9]{24}$/.test(id) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_START_TARGET');
  return `umask 077; if ! command -v dsh >/dev/null 2>&1; then printf 'DSH_MISSING\\n'; exit 0; fi; D="$HOME/.dsh-phone-ssh/${id}"; mkdir -p "$D" || exit 1; if test -f "$D/web.pid" && kill -0 "$(cat "$D/web.pid")" 2>/dev/null; then printf 'DSH_ALREADY_STARTING\\n'; else : > "$D/web.log"; nohup dsh web --host 127.0.0.1 --port ${port} --no-open </dev/null >>"$D/web.log" 2>&1 & printf '%s\\n' "$!" > "$D/web.pid"; printf 'DSH_START_REQUESTED\\n'; fi`;
}

export function logCommand(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('INVALID_START_TARGET');
  return `D="$HOME/.dsh-phone-ssh/${id}"; if test -f "$D/web.log"; then tail -c 32768 "$D/web.log"; fi`;
}

export function execute(client, command, signal, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let channel, output = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { channel?.destroy(); reject(error); } else resolve(value); };
    const abort = () => finish(new Error('CANCELLED'));
    const timer = setTimeout(() => finish(new Error('REMOTE_TIMEOUT')), timeout);
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) return abort();
    client.exec(command, {pty:false}, (error, stream) => {
      if (error) return finish(new Error('REMOTE_EXEC_FAILED'));
      channel = stream;
      if (done) return stream.destroy();
      const collect = b => { output += b.toString('utf8'); if (Buffer.byteLength(output) > 65536) finish(new Error('REMOTE_OUTPUT_LIMIT')); };
      stream.on('data', collect);
      stream.stderr.on('data', () => {});
      stream.on('error', () => finish(new Error('REMOTE_EXEC_FAILED')));
      stream.on('close', code => code === 0 ? finish(null, output) : finish(new Error('REMOTE_EXEC_FAILED')));
    });
  });
}

export function tunnelAgent(client, remotePort, resources, signal, timeout = 5000) {
  const agent = new http.Agent({keepAlive:false, maxSockets:16, maxTotalSockets:24});
  agent.createConnection = (_options, callback) => {
    if (signal?.aborted) { callback(new Error('CANCELLED')); return; }
    let finished = false;
    const timer = setTimeout(() => { if (!finished) { finished = true; callback(new Error('FORWARD_TIMEOUT')); } }, timeout);
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, stream) => {
      if (finished || signal?.aborted) { stream?.destroy(); clearTimeout(timer); if (!finished) callback(new Error('CANCELLED')); return; }
      finished = true; clearTimeout(timer);
      if (error) return callback(new Error('FORWARD_REFUSED'));
      resources.add(stream); stream.once('close', () => resources.delete(stream));
      for (const method of ['setKeepAlive','setNoDelay','setTimeout','ref','unref']) stream[method] = () => stream;
      stream.destroySoon = stream.destroy;
      callback(null, stream);
    });
  };
  return agent;
}

const excluded = new Set(['connection','proxy-connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','cookie','set-cookie','host','origin','referer','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
function copyHeaders(headers) { return Object.fromEntries(Object.entries(headers).filter(([k]) => !excluded.has(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-fetch-'))); }
const secretEqual = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

export async function createWebForward({client, id, remotePort, webToken, signal, timeout = 8000}) {
  const channels = new Set(), sockets = new Set(), jar = new Map();
  const agent = tunnelAgent(client, remotePort, channels, signal, timeout);
  const remoteHost = `127.0.0.1:${remotePort}`, remoteOrigin = `http://${remoteHost}`;
  const cookieName = 'dsh_ssh_scope', cookie = randomBytes(32).toString('hex');
  let ticket = randomBytes(32).toString('hex'), ticketUntil = Date.now()+120000, closed = false, origin, authority;
  function absorb(response) {
    for (const raw of response.headers['set-cookie'] ?? []) {
      const match = /^([!#$%&'*+.^_`|~\w-]+)=([^;\r\n]*)/.exec(raw);
      if (!match) continue;
      if (jar.size >= 64 && !jar.has(match[1])) continue;
      if (/max-age\s*=\s*0(?:;|$)/i.test(raw)) jar.delete(match[1]); else jar.set(match[1],match[2]);
    }
  }
  function headers(input = {}) {
    const out = {...copyHeaders(input), host:remoteHost};
    if (input.origin) out.origin = remoteOrigin;
    if (jar.size) out.cookie = [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
    return out;
  }
  function request(path, input = {}, method = 'GET') { return http.request({host:'127.0.0.1', port:remotePort, path, method, headers:headers(input), agent}); }
  const initial = await new Promise((resolve, reject) => {
    const req = request(webToken ? '/?token='+encodeURIComponent(webToken) : '/');
    const timer = setTimeout(() => req.destroy(new Error('REMOTE_WEB_TIMEOUT')), timeout);
    req.on('error', () => { clearTimeout(timer); reject(new Error('REMOTE_WEB_UNREACHABLE')); });
    req.on('response', res => { clearTimeout(timer); absorb(res); res.resume(); resolve(res.statusCode); });
    req.end();
  }).catch(error => { agent.destroy(); for(const c of channels)c.destroy(); throw error; });
  if (initial === 401 || initial === 403) { agent.destroy(); throw new Error('REMOTE_WEB_AUTH_REQUIRED'); }
  if (initial >= 500) { agent.destroy(); throw new Error('REMOTE_WEB_FAILED'); }
  const reject = (res, code) => {res.writeHead(code, {'content-type':'text/plain;charset=utf-8','cache-control':'no-store'});res.end('SSH forward unavailable');};
  function allowed(req, res) {
    if (closed || req.headers.host !== authority || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { reject(res,403); return false; }
    if (!req.url.startsWith('/') || req.url.startsWith('//') || /[\r\n\0\\]/.test(req.url) || req.url.length > 16384) { reject(res,400); return false; }
    if (req.headers.origin && req.headers.origin !== origin) { reject(res,403); return false; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { reject(res,403); return false; }
    const own = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if (!secretEqual(own,cookie)) { reject(res,401); return false; }
    return true;
  }
  const server = http.createServer((req,res) => {
    if (req.headers.host === authority && req.method === 'GET' && req.url === '/__ssh_open/'+ticket && ticket && Date.now() <= ticketUntil) {
      ticket = ''; res.writeHead(303, {'location':'/','set-cookie':`${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`, 'referrer-policy':'no-referrer','cache-control':'no-store'}); res.end(); return;
    }
    if (!allowed(req,res)) return;
    if (sockets.size > 48 || channels.size > 32) return reject(res,429);
    const upstream = request(req.url,req.headers,req.method);
    upstream.on('error', () => {if (!res.headersSent)reject(res,502);else res.destroy();});
    const timer = setTimeout(() => upstream.destroy(new Error('FORWARD_TIMEOUT')), timeout);
    upstream.on('response', remote => {
      clearTimeout(timer); absorb(remote); const h = copyHeaders(remote.headers);
      if (remote.headers.location) {
        let location;
        try { const url = new URL(remote.headers.location,remoteOrigin); if (url.origin !== remoteOrigin || url.username || url.password) throw Error(); location = url.pathname+url.search+url.hash; } catch { remote.destroy(); return reject(res,502); }
        h.location = location;
      }
      h['referrer-policy'] = 'no-referrer'; res.writeHead(remote.statusCode,h);remote.on('error',()=>res.destroy());remote.pipe(res);
    });
    upstream.once('close',()=>clearTimeout(timer));req.on('aborted',()=>upstream.destroy());res.once('close',()=>upstream.destroy());req.pipe(upstream);
  });
  server.on('connection',socket=>{ sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{}); });
  server.on('connect',(_req,socket)=>socket.destroy());
  server.on('upgrade',(req,socket,head) => {
    const shim={writeHead(code){socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);},end(){}};
    if (!allowed(req,shim) || channels.size >= 32 || req.method!=='GET' || req.headers.upgrade?.toLowerCase()!=='websocket') {socket.destroy();return;}
    const h = headers(req.headers);h.connection='Upgrade';h.upgrade='websocket';
    const upstream=http.request({host:'127.0.0.1',port:remotePort,path:req.url,headers:h,agent});
    const timer=setTimeout(()=>upstream.destroy(),timeout);
    upstream.on('error',()=>{clearTimeout(timer);socket.destroy();});
    upstream.on('response',res=>{clearTimeout(timer);res.resume();socket.destroy();});
    upstream.on('upgrade',(res,remote,remoteHead)=>{clearTimeout(timer);absorb(res);const responseHeaders=copyHeaders(res.headers);responseHeaders.connection='Upgrade';responseHeaders.upgrade='websocket';socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(responseHeaders).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());socket.pipe(remote).pipe(socket);});
    upstream.end();
  });
  server.maxConnections=48;server.headersTimeout=15000;server.requestTimeout=120000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  authority=`dsh-ssh-${id}.localhost:${server.address().port}`;origin='http://'+authority;
  const close = async () => {if(closed)return;closed=true;ticket='';jar.clear();agent.destroy();for(const c of channels)c.destroy();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));};
  signal?.addEventListener('abort',()=>void close(),{once:true});
  if(signal?.aborted){await close();throw new Error('CANCELLED');}
  return {origin, localAddress:server.address(), openUrl:()=>{if(closed)throw new Error('DISCONNECTED');ticket=randomBytes(32).toString('hex');ticketUntil=Date.now()+120000;return origin+'/__ssh_open/'+ticket;},close};
}
