import { createServer, request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createGzip, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { MAX_BODY } from './protocol.mjs';
import {createQuietSessionBridge} from './quiet-session-bridge.mjs';
import {createWsMessageBridge, configureWs, wsOffer, wsCapabilities, WS_MESSAGE_LIMIT, WS_QUEUE_LIMIT} from './ws-message-bridge.mjs';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const HOP = new Set(['host', 'connection', 'upgrade', 'transfer-encoding', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'cookie', 'set-cookie', 'origin', 'referer', 'sec-fetch-site', 'accept-encoding', 'content-length']);
export function cleanHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([k, v]) => !HOP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-websocket-') && (typeof v === 'string' || Array.isArray(v))));
}
function safePath(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) throw Error('Invalid path');
  return new URL(value, 'http://127.0.0.1').pathname + new URL(value, 'http://127.0.0.1').search;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const comboPath = path => path.startsWith('/plugins/??') && /&rev=[a-f0-9]{12}$/.test(path) && path.length <= 8192;
const requestLimit = (service,method,url) => service === 'ui' && method === 'POST' && url.split('?')[0] === '/phone-chat-files/upload' ? 64*1024*1024 : MAX_BODY;
const recoveryClient = `(function(){
  var stopped=false,running=false,timer=null,checks=0;
  function schedule(){if(!stopped&&!document.hidden)timer=setTimeout(check,checks<10?1200:5000)}
  function canNavigate(){
    try{var now=Date.now(),key='dsh-peer-page-recoveries',times=JSON.parse(sessionStorage.getItem(key)||'[]').filter(function(t){return typeof t==='number'&&now-t<60000});if(times.length>=3)return false;times.push(now);sessionStorage.setItem(key,JSON.stringify(times));return true}catch(e){return false}
  }
  function check(){
    if(stopped||running||document.hidden)return;running=true;checks++;
    var controller=typeof AbortController==='function'?new AbortController():null;
    var deadline=controller?setTimeout(function(){controller.abort()},3000):null;
    fetch('/__dsh_peer_status',{cache:'no-store',credentials:'omit',signal:controller?controller.signal:undefined}).then(function(r){if(!r.ok)throw Error('unavailable');return r.json()}).then(function(s){
      if(!stopped&&!document.hidden&&s.online===true&&canNavigate()){stopped=true;location.replace('/'+location.hash)}
    }).catch(function(){}).finally(function(){if(deadline!==null)clearTimeout(deadline);running=false;schedule()});
  }
  document.addEventListener('visibilitychange',function(){if(timer!==null)clearTimeout(timer);if(!document.hidden)check()});
  window.addEventListener('pagehide',function(){stopped=true;if(timer!==null)clearTimeout(timer)});
  check();
})();`;
const recoveryHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在恢复电脑连接</title><style>body{font:16px/1.7 system-ui,sans-serif;padding:24px;color:#24324a;background:#f5f7fb}main{max-width:540px;margin:12vh auto}a{display:inline-block;margin:12px 20px 0 0;color:#245dc1}</style></head><body><main><h2>正在恢复电脑连接…</h2><p>请保持电脑和 DSH 运行，连接恢复后会自动打开。已提交的消息不会重复发送。</p><a href="/">立即重试</a><a href="http://127.0.0.1:3080/">返回手机本机</a></main><script id="dsh-peer-recovery">${recoveryClient}</script></body></html>`;
const bootstrapRecovery = `<script id="dsh-peer-bootstrap-recovery">(function(){
  if(window.__dshPeerPageRecovery)return;window.__dshPeerPageRecovery=true;
  window.addEventListener('error',function(event){
    var node=event.target;if(document.readyState==='complete'||!node||!node.tagName)return;
    var url=node.src||node.href||'';
    if(!/^(SCRIPT|LINK)$/.test(node.tagName)||!/(?:\\/assets\\/|\\/plugins\\/\\?\\?)/.test(url))return;
    try{if(new URL(url,location.href).origin!==location.origin)return}catch(e){return}
    location.replace('/__dsh_peer_recover'+location.hash);
  },true);
})();</script>`;
const quietVisibilityClient = `<script id="dsh-peer-quiet-visibility">(()=>{if(window.__dshPeerQuietVisibility)return;window.__dshPeerQuietVisibility=true;const Native=window.WebSocket,sockets=new Set();function report(ws){if(ws.readyState===Native.OPEN)ws.send(JSON.stringify({type:'dsh-peer-visibility',hidden:document.hidden}));}window.WebSocket=class extends Native{constructor(...args){super(...args);let url;try{url=new URL(args[0],location.href)}catch{return}if(url.host!==location.host||url.pathname!=='/api/remote.mux')return;sockets.add(this);this.addEventListener('open',()=>report(this));this.addEventListener('close',()=>sockets.delete(this),{once:true});}};document.addEventListener('visibilitychange',()=>{for(const ws of sockets)report(ws)});window.addEventListener('pagehide',()=>sockets.clear(),{once:true});})();</script>`;
export function createPeerProxy(tunnel, { role, webPort = 3080, localWebPort, uiHeaders = async () => ({}), gatewayPort = 8326, gatewayKey = async () => undefined, allowGateway = () => true, transformHtml = html => html, assets = new Map(), reusableScripts = [], quietAfterMs = 30000 } = {}) {
  const reusable = new Map(reusableScripts.filter(bytes => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BODY / 2).slice(0, 1).map(bytes => [digest(bytes), bytes]));
  const outgoing = new Map(), incoming = new Map(), localWs = new Map(), remoteWs = new Map();
  const wsMessages = createWsMessageBridge(tunnel);
  const dropWs = ws => {ws.peerQuiet?.close();clearTimeout(ws.peerEndTimer);wsMessages.drop(ws);};
  const sendWs = (type,id,ws,data,binary) => wsMessages.send(type,id,ws,data,binary);
  const receiveWs = (ws,m,chunked) => wsMessages.receive(ws,m,chunked);
  // Bound all response chunks together, including concurrent asset downloads.
  // A small window avoids paying a full WAN round trip for every 48 KiB.
  let chunkCalls = 0;
  const chunkWaiters = [];
  let preloads;
  const localResponse = async path => {
    const headers = await uiHeaders();
    return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: localWebPort, path, method: 'GET', headers }, resolve);
    req.once('error', reject); req.setTimeout(2000, () => req.destroy(Error('Local asset unavailable'))); req.end();
    });
  };
  const localAsset = async (req, res) => {
    if (role !== 'phone' || !localWebPort || req.method !== 'GET') return false;
    const hashed = /^\/assets\/[\w.-]+-[\w-]{8}\.(?:js|css)$/.test(req.url);
    const sdk = /^\/plugins\/@deepseek-ai\/dsh-client-(?:modules|runtime)\/client\.js\?rev=[a-f0-9]{12}$/.test(req.url) ||
      (req.url.startsWith('/plugins/??') && /&rev=[a-f0-9]{12}$/.test(req.url) && req.url.length <= 8192);
    if (!hashed && !sdk) return false;
    try {
      if (sdk) {
        preloads ??= (async () => {
          const response = await localResponse('/'); let html = '';
          for await (const bytes of response) { html += bytes.toString(); if (html.length > MAX_BODY) { response.destroy(); throw Error('Local document too large'); } }
          return new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => {
            const url = new URL(match[1].replaceAll('&amp;', '&'), `http://127.0.0.1:${localWebPort}/`);
            return url.origin === `http://127.0.0.1:${localWebPort}` ? url.pathname + url.search : '';
          }));
        })().catch(() => new Set());
        // The full revision must match, so mobile SDK overlays cannot replace
        // a different desktop build. Computer APIs always use the tunnel.
        if (!(await preloads).has(req.url)) return false;
      }
      const response = await localResponse(req.url);
      if (response.statusCode !== 200 || !/(?:javascript|text\/css)/.test(String(response.headers['content-type']))) { response.resume(); return false; }
      res.writeHead(200, cleanHeaders(response.headers));
      res.on('close', () => response.destroy()); response.on('error', () => res.destroy()); response.pipe(res);
      return true;
    } catch { return false; }
  };
  const sendChunk = async (id, bytes) => {
    if (chunkCalls >= 16) await new Promise(resolve => chunkWaiters.push(resolve)); else chunkCalls++;
    try {
      if (!incoming.has(id)) throw Error('Stream cancelled');
      return await tunnel.call('http.chunk', { id, data: bytes.toString('base64') });
    } finally { const next = chunkWaiters.shift(); if (next) next(); else chunkCalls--; }
  };
  const target = service => {
    if (service === 'ui' && role === 'computer') return webPort;
    if (service === 'gateway' && role === 'phone' && allowGateway()) return gatewayPort;
    throw Error('Peer service is not shared');
  };
  const finishHttp = async (id, stream) => {
    stream.req.end();
    try {
      const response = await stream.wait; stream.response = response;
      const headers = cleanHeaders(response.headers);
      let bodySource = response, reused;
      if (stream.reuse && response.statusCode === 200 && !headers['content-encoding'] && /javascript/.test(String(headers['content-type']))) {
        const chunks = [], iterator = response[Symbol.asyncIterator](); let size = 0, complete = false;
        while (size <= MAX_BODY) {
          const next = await iterator.next();
          if (next.done) { complete = true; break; }
          chunks.push(next.value); size += next.value.length;
        }
        if (complete) {
          const body = Buffer.concat(chunks), offset = body.indexOf(stream.reuse.bytes);
          if (offset >= 0) {
            reused = { hash: stream.reuse.hash, offset, size: stream.reuse.bytes.length, fullSize: body.length, fullHash: digest(body) };
            bodySource = Readable.from([body.subarray(0, offset), body.subarray(offset + reused.size)]);
          } else bodySource = Readable.from([body]);
        } else bodySource = Readable.from((async function* () {
          yield* chunks;
          for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; }
        })());
      }
      const compressed = stream.compress && response.statusCode === 200 && !headers['content-encoding'] && /(?:javascript|text\/css|image\/svg)/.test(String(headers['content-type']));
      if (compressed) {
        headers['content-encoding'] = 'gzip'; delete headers.etag;
        headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
      }
      const source = compressed ? bodySource.pipe(createGzip({ level: 6 })) : bodySource;
      bodySource.once('error', error => source.destroy(error));
      response.once('error', error => source.destroy(error));
      const iterator = source[Symbol.asyncIterator]();
      const prefix = [];
      if (stream.inline && response.statusCode === 200 && /(?:javascript|text\/css|text\/html|image\/svg)/.test(String(headers['content-type']))) {
        let size = 0;
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            incoming.delete(id);
            return { status: response.statusCode, headers, ...(reused ? { reused } : {}), inlineBody: Buffer.concat(prefix).toString('base64') };
          }
          prefix.push(next.value); size += next.value.length;
          if (size > 196608) break;
        }
      }
      setImmediate(async () => {
        const jobs = new Set();
        try {
          async function* chunks() {
            yield* prefix;
            for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; }
          }
          for await (const bytes of chunks()) for (let i = 0; i < bytes.length; i += 49152) {
            const job = sendChunk(id, bytes.subarray(i, i + 49152)); jobs.add(job);
            job.then(() => jobs.delete(job), () => {});
            if (jobs.size >= 8) await Promise.race(jobs);
          }
          await Promise.all(jobs);
          await tunnel.call('http.done', { id });
        } catch {
          source.destroy(); response.destroy();
          try { await tunnel.call('http.done', { id, error: true }); } catch {}
        } finally { await Promise.allSettled(jobs); incoming.delete(id); }
      });
      return { status: response.statusCode, headers, ...(reused ? { reused } : {}) };
    } catch (e) { incoming.delete(id); stream.req.destroy(); throw e; }
  };
  const httpAction = async (action, value) => {
    const id = value?.id;
    if (typeof id !== 'string' || id.length > 64) throw Error('Invalid stream');
    if (action === 'http.begin') {
      if (incoming.size >= 16 || incoming.has(id)) throw Error('Too many requests');
      const port = target(value.service), url = safePath(value.url);
      if (value.service === 'gateway' && !/^\/v1\/(models|chat\/completions)(\?|$)/.test(url)) throw Error('Gateway path not shared');
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(value.method)) throw Error('Invalid method');
      const headers = cleanHeaders(value.headers); headers.origin = `http://127.0.0.1:${port}`;
      // The phone adds its own presentation to documents. The computer's ETag
      // cannot validate that transformed HTML after a phone UI upgrade.
      if (value.service === 'ui' && value.method === 'GET' &&
          (/text\/html/.test(headers.accept || '') || /(?:\/|\.html)$/.test(url.split('?')[0]))) {
        delete headers['if-none-match']; delete headers['if-modified-since'];
      }
      if (value.service === 'ui') Object.assign(headers, await uiHeaders());
      if (value.service === 'gateway') { const key = await gatewayKey(); if (key) headers.authorization = `Bearer ${key}`; }
      const req = request({ hostname: '127.0.0.1', port, path: url, method: value.method, headers });
      // New DSH combines scripts at /plugins/??a/client.js,b/client.js&rev=…
      // MIME verification in finishHttp decides which responses may compress.
      const stream = { req, response: null, size: 0, maxBody: requestLimit(value.service,value.method,url), wait: null, inline: value.service === 'ui' && value.method === 'GET' && value.fast === true && value.inline === true, compress: value.service === 'ui' && value.method === 'GET' && value.compress === true };
      if (value.service === 'ui' && value.method === 'GET' && value.fast === true && comboPath(url) &&
          typeof value.reuse?.hash === 'string' && reusable.get(value.reuse.hash)?.length === value.reuse.size) {
        stream.reuse = { hash: value.reuse.hash, bytes: reusable.get(value.reuse.hash) };
      }
      stream.wait = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
      // Upload or cancellation may fail before http.end attaches its await.
      stream.wait.catch(() => {}); incoming.set(id, stream);
      req.setTimeout(600000, () => req.destroy(Error('Upstream timed out')));
      if (value.fast === true && ['GET', 'HEAD'].includes(value.method)) return finishHttp(id, stream);
      return {};
    }
    if (action === 'http.chunk' || action === 'http.done') {
      const stream = outgoing.get(id); if (!stream) return {};
      await stream.head;
      if (action === 'http.done') {
        outgoing.delete(id);
        if (value.error) { if (stream.recover) stream.recover(); else stream.res.destroy(Error('Remote stream interrupted')); } else stream.res.end();
      } else {
        const bytes = Buffer.from(value.data, 'base64');
        if (bytes.length > 65536) throw Error('Chunk too large');
        if (!stream.res.destroyed && !stream.res.write(bytes)) await Promise.race([once(stream.res, 'drain'), once(stream.res, 'close')]);
      }
      return {};
    }
    const stream = incoming.get(id); if (!stream) throw Error('Stream no longer active');
    if (action === 'http.cancel') { incoming.delete(id); stream.req.destroy(); stream.response?.destroy(); return {}; }
    if (action === 'http.upload') {
      const bytes = Buffer.from(value.data, 'base64'); stream.size += bytes.length;
      if (bytes.length > 65536 || stream.size > stream.maxBody) { incoming.delete(id); stream.req.destroy(); throw Error('Request body too large'); }
      if (stream.req.destroyed || stream.req.writableEnded) { incoming.delete(id); throw Error('Request upload closed'); }
      // The close event may already have fired after an early upstream error.
      // The write callback settles on both drain and destruction without
      // retaining a peer RPC slot waiting for a past close event.
      await new Promise((resolve, reject) => stream.req.write(bytes, error => error ? reject(error) : resolve()));
      return {};
    }
    if (action !== 'http.end') throw Error('Invalid HTTP operation');
    return finishHttp(id, stream);
  };
  const wsAction = async (action, value) => {
    const id = value?.id;
    if (typeof id !== 'string' || id.length > 64) throw Error('Invalid socket');
    if(action==='ws.transfer'){
      const uplink=value.type==='ws.uplink.chunk',downlink=value.type==='ws.data.chunk';
      const ws=uplink?remoteWs.get(id):downlink?localWs.get(id):undefined;
      if(!ws||!ws.peerAcknowledgedChunks||(uplink&&!ws.allowUplink)||ws.readyState!==WebSocket.OPEN)throw Error('Socket transfer unavailable');
      if(!wsMessages.receive(ws,value,true))throw Error('Socket transfer rejected');
      return {};
    }
    if (action === 'ws.open') {
      if (remoteWs.size >= 8 || remoteWs.has(id)) throw Error('Too many sockets');
      const port = target('ui'), url = safePath(value.url);
      if (!['/api/events.mux', '/api/events.host', '/api/remote.mux'].includes(url)) throw Error('Socket path not shared');
      const caps=wsCapabilities(value);
      const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`, { origin: `http://127.0.0.1:${port}`, headers: await uiHeaders(), maxPayload:caps.maxMessageBytes, perMessageDeflate: false });
      ws.allowUplink = url === '/api/remote.mux';
      remoteWs.set(id, ws); ws.on('error', () => {});
      configureWs(ws,caps);
      let ready = false, queuedSize = 0; const queued = [];
      const forward = (data, binary) => { try { sendWs('ws.data',id,ws,data,binary); } catch { ws.terminate(); } };
      // DSH sends an initial state snapshot immediately on upgrade. Retain
      // it until the mobile browser has completed its own local upgrade.
      ws.on('message', (data, binary) => {
        if (ready) forward(data, binary);
        else { queuedSize += data.length; if (queuedSize > WS_QUEUE_LIMIT) ws.terminate(); else queued.push([data, binary]); }
      });
      const finish = () => wsMessages.finishSend(ws,()=>{
        dropWs(ws);remoteWs.delete(id);try{tunnel.send({type:'ws.close',id})}catch{}
      });
      ws.activate = () => {clearTimeout(ws.peerEndTimer);ready=true;for(const frame of queued)forward(...frame);queued.length=0;if(ws.peerEnded)finish();};
      ws.on('close', () => {
        ws.peerEnded=true;
        if(ready)finish();else{ws.peerEndTimer=setTimeout(finish,15000);ws.peerEndTimer.unref();}
      });
      let timer;
      try { await new Promise((resolve, reject) => {
        ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(Error('Upstream socket closed')));
        timer = setTimeout(() => { ws.terminate(); reject(Error('Upstream socket timed out')); }, 15000); timer.unref();
      }); } catch (e) { remoteWs.delete(id); ws.terminate(); throw e; } finally { clearTimeout(timer); }
      return caps;
    }
    if (action === 'ws.ready') { const ws = remoteWs.get(id); if (!ws || ws.readyState === WebSocket.CONNECTING) throw Error('Socket disconnected'); ws.activate(); return {}; }
    if (action === 'ws.close') { const ws=remoteWs.get(id);if(ws){dropWs(ws);ws.terminate();}remoteWs.delete(id);return {}; }
    throw Error('Invalid socket operation');
  };
  const packet = m => {
    if (m.type === 'ws.uplink' || m.type === 'ws.uplink.chunk') {
      const upstream = remoteWs.get(m.id);
      if (!upstream?.allowUplink || upstream.readyState !== WebSocket.OPEN) return;
      receiveWs(upstream,m,m.type==='ws.uplink.chunk');
      return;
    }
    const ws = localWs.get(m.id);
    if (m.type === 'ws.close') { if(ws)wsMessages.finishReceive(ws,()=>{dropWs(ws);ws.close();localWs.delete(m.id);}); }
    if ((m.type === 'ws.data'||m.type==='ws.data.chunk') && ws?.readyState === WebSocket.OPEN) {
      receiveWs(ws,m,m.type==='ws.data.chunk');
    }
  };
  tunnel.on('packet', packet);
  const disconnected = () => {
    for (const stream of outgoing.values()) { stream.resolveHead(); if (stream.recover) stream.recover(); else stream.res.destroy(); }
    outgoing.clear(); for (const stream of incoming.values()) { stream.req.destroy(); stream.response?.destroy(); } incoming.clear();
    for (const ws of [...localWs.values(), ...remoteWs.values()]) { dropWs(ws);ws.terminate(); } localWs.clear(); remoteWs.clear();
  };
  tunnel.on('offline', disconnected);
  const browserTrust = req => {
    if (!loopback(req.socket.remoteAddress)) return false;
    const host = req.headers.host;
    if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return !req.headers.origin || new URL(req.headers.origin).host === host;
  };
  function serverFor(service) {
    const server = createServer(async (req, res) => {
      let id, stream;
      try {
        if (!browserTrust(req)) { res.writeHead(403).end(); return; }
        const recoverable = service === 'ui' && req.method === 'GET' && req.url.split('?')[0] === '/';
        const recover = recoverable ? (() => {
          const end = res.end.bind(res);
          return () => {
            if (res.destroyed || res.writableEnded) return;
            if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            end(recoveryHtml);
          };
        })() : undefined;
        if (service === 'ui' && req.url === '/__dsh_peer_status') {
          if (req.method !== 'GET') { res.writeHead(405).end(); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ online: tunnel.online === true, route: tunnel.route ?? (tunnel.online ? 'relay' : 'offline') })); return;
        }
        if (service === 'ui' && req.url === '/__dsh_peer_recover' && req.method === 'GET') {
          res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(recoveryHtml); return;
        }
        if (service === 'ui' && assets.has(req.url)) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(assets.get(req.url)); return; }
        if (!tunnel.online) {
          if (recover) { recover(); return; }
          if (service === 'gateway') {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code: 'PEER_OFFLINE', type: 'server_error', message: '手机模型网关离线，请保持手机 DSH 运行并检查两端连接；请求没有自动重发。' } }));
          } else {
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }); res.end('<meta name="viewport" content="width=device-width"><p>电脑离线或连接中。请保持家里电脑和 DSH 运行。</p><a href="http://127.0.0.1:3080/">返回手机本机</a>');
          }
          return;
        }
        if (service === 'ui' && await localAsset(req, res)) return;
        id = randomUUID();
        stream = { res, recover, resolveHead: null, head: null }; stream.head = new Promise(resolve => { stream.resolveHead = resolve; }); outgoing.set(id, stream);
        res.on('close', () => { if (outgoing.delete(id)) { stream.resolveHead(); void tunnel.call('http.cancel', { id }).catch(() => {}); } });
        const fast = ['GET', 'HEAD'].includes(req.method) && !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0');
        const offer = service === 'ui' && fast && req.method === 'GET' && comboPath(req.url) ? [...reusable].map(([hash, bytes]) => ({ hash, size: bytes.length }))[0] : undefined;
        let head = await tunnel.call('http.begin', { id, service, method: req.method, url: req.url, headers: cleanHeaders(req.headers), fast, inline: service === 'ui' && fast, ...(offer ? { reuse: offer } : {}), compress: /\bgzip\b/.test(req.headers['accept-encoding'] || '') });
        let length = 0;
        for await (const bytes of req) {
          length += bytes.length;
          const maxBody=requestLimit(service,req.method,req.url);
          if (length > maxBody) { const e = Error(`远程上传最多 ${maxBody/1024/1024} MB`); e.status = 413; throw e; }
          for (let i = 0; i < bytes.length; i += 49152) await tunnel.call('http.upload', { id, data: bytes.subarray(i, i + 49152).toString('base64') });
        }
        // Older peers return an empty begin reply; retain compatibility.
        if (!head?.status) head = await tunnel.call('http.end', { id }, 600000);
        const attachment = /^\s*attachment(?:\s*;|\s*$)/i.test(String(head.headers['content-disposition'] ?? ''));
        const html = service === 'ui' && !attachment && String(head.headers['content-type']).includes('text/html');
        if (head.reused) {
          const reused = head.reused, local = reusable.get(reused.hash);
          if (!offer || !local || reused.hash !== offer.hash || reused.size !== local.length ||
              !Number.isSafeInteger(reused.offset) || reused.offset < 0 || !Number.isSafeInteger(reused.fullSize) ||
              reused.fullSize > MAX_BODY || reused.offset + reused.size > reused.fullSize ||
              !/^[a-f0-9]{64}$/.test(reused.fullHash) || !/javascript/.test(String(head.headers['content-type']))) throw Error('Invalid UI reuse receipt');
          const encoding = head.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'gzip') throw Error('Unsupported UI encoding');
          delete head.headers['content-encoding']; delete head.headers['content-length'];
          const parts = []; let size = 0;
          const originalWrite = res.write.bind(res), originalEnd = res.end.bind(res);
          res.write = bytes => { size += bytes.length; if (size > MAX_BODY) throw Error('UI reuse body too large'); parts.push(Buffer.from(bytes)); return true; };
          res.end = () => {
            res.write = originalWrite; res.end = originalEnd;
            try {
              let transferred = Buffer.concat(parts);
              if (encoding === 'gzip') transferred = gunzipSync(transferred, { maxOutputLength: MAX_BODY });
              if (transferred.length + local.length !== reused.fullSize) throw Error('UI reuse size mismatch');
              const body = Buffer.concat([transferred.subarray(0, reused.offset), local, transferred.subarray(reused.offset)]);
              if (digest(body) !== reused.fullHash) throw Error('UI reuse content mismatch');
              originalEnd(body);
            } catch { res.destroy(); }
          };
        }
        if (html) {
          delete head.headers.etag; delete head.headers['last-modified'];
          head.headers['cache-control'] = 'no-store';
          const parts = []; let size = 0;
          // Intercept only documents. Assets and streamed task/API responses
          // retain their original transport and completion semantics.
          const originalWrite = res.write.bind(res), originalEnd = res.end.bind(res);
          res.write = bytes => { size += bytes.length; if (size > MAX_BODY) throw Error('Document too large'); parts.push(Buffer.from(bytes)); return true; };
          res.end = () => {
            res.write = originalWrite; res.end = originalEnd;
            let body = transformHtml(Buffer.concat(parts).toString());
            if (role === 'phone' && stream.recover) body = body.replace('</body>',quietVisibilityClient+'</body>');
            if (stream.recover) body = body.replace(/<head(?:\s[^>]*)?>/i, head => head + bootstrapRecovery);
            originalEnd(body);
          };
          delete head.headers['content-security-policy'];
        }
        res.writeHead(head.status, head.headers); stream.resolveHead();
        if (head.inlineBody !== undefined) {
          if (typeof head.inlineBody !== 'string' || head.inlineBody.length > 262144) throw Error('Inline response too large');
          const bytes = Buffer.from(head.inlineBody, 'base64');
          if (bytes.length > 196608) throw Error('Inline response too large');
          outgoing.delete(id); res.write(bytes); res.end();
        }
      } catch (e) {
        stream?.resolveHead(); if (id) { outgoing.delete(id); void tunnel.call('http.cancel', { id }).catch(() => {}); }
        if (res.writableEnded || res.destroyed) return;
        if (stream?.recover) stream.recover();
        else if (res.headersSent) res.destroy();
        else if (service === 'gateway') {
          res.writeHead(e.status ?? 502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'PEER_UNAVAILABLE', type: 'server_error', message: '手机模型网关连接未完成，请检查两端服务和网络；请求没有自动重发。' } }));
        } else { res.writeHead(e.status ?? 502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('远程连接不可用，请检查两端服务；请求没有自动重发。'); }
      }
    });
    if (service === 'ui') {
      const acceptor = new WebSocketServer({ noServer: true, maxPayload: WS_MESSAGE_LIMIT });
      server.on('upgrade', async (req, socket, head) => {
        try {
          if (!browserTrust(req) || !tunnel.online) throw Error();
          const id = randomUUID(), negotiated=await tunnel.call('ws.open', { id, url: req.url, ...wsOffer() });
          if (socket.destroyed) { void tunnel.call('ws.close', { id }).catch(() => {}); return; }
          acceptor.handleUpgrade(req, socket, head, ws => {
            localWs.set(id, ws); ws.on('error', () => {});
            configureWs(ws,negotiated);
            if (role === 'phone' && req.url === '/api/remote.mux') {
              const quiet = ws.peerQuiet = createQuietSessionBridge({quietAfterMs, send: message => sendWs('ws.uplink',id,ws,Buffer.from(JSON.stringify(message)),false)});
              const originalSend = ws.send.bind(ws);
              ws.send = (data,options,callback) => {
                const transformed = quiet.downlink(data,options?.binary===true);
                if (transformed===null) { (typeof options==='function'?options:callback)?.();return; }
                return originalSend(transformed,options,callback);
              };
            }
            ws.on('message', (data, binary) => {
              if (req.url !== '/api/remote.mux') { ws.close(1008, 'downlink only'); return; }
              if (data.length > ws.peerMessageBytes) { ws.close(1009, 'frame too large'); return; }
              try {
                if(ws.peerQuiet&&!binary){let value;try{value=JSON.parse(data.toString())}catch{}if(value?.type==='dsh-peer-visibility'){if(typeof value.hidden!=='boolean')throw Error('Invalid visibility');ws.peerQuiet.visibility(value.hidden);return;}}
                sendWs('ws.uplink',id,ws,ws.peerQuiet?.uplink(data,binary)??data,binary);
              }
              catch { ws.terminate(); }
            });
            ws.on('close', () => { dropWs(ws);localWs.delete(id); void tunnel.call('ws.close', { id }).catch(() => {}); });
            void tunnel.call('ws.ready', { id }).catch(() => ws.terminate());
          });
        } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
      });
    }
    return server;
  }
  return {
    ui: serverFor('ui'), gateway: serverFor('gateway'),
    action: (action, value) => action.startsWith('http.') ? httpAction(action, value) : wsAction(action, value),
    close() { disconnected(); tunnel.off('packet', packet); tunnel.off('offline', disconnected); },
  };
}
