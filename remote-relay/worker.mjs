const ROOM = /^[a-f0-9]{32}$/;
const PROOF = /^[a-f0-9]{64}$/;
const MAX_ADMIN_BODY = 512;
const MAX_JOIN = 2048;
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 2;
const MAX_SOCKETS = 8; // Includes sockets completing their close handshake.
const JOIN_MS = 5000;
const encoder = new TextEncoder();
const CONNECT_SCRIPT = `const payload = location.hash.slice(1);
const openLink = document.getElementById('open');
const status = document.getElementById('status');
if (payload.length <= 2048 && /^dsh-peer:1:[A-Za-z0-9_-]+$/.test(payload)) {
  openLink.href = 'dsh-phone://peer/connect#' + payload;
  openLink.hidden = false;
  status.textContent = '点击下方链接，在已安装的 DSH 中打开连接。';
} else {
  status.textContent = '连接链接无效，请从电脑重新生成。';
}`;

async function connectPage() {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(CONNECT_SCRIPT)));
  const hash = btoa(String.fromCharCode(...digest));
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打开 DSH</title><h1>连接电脑上的 DSH</h1><p id="status">请使用电脑生成的完整连接链接。</p><a id="open" hidden>打开 DSH</a><noscript>请启用 JavaScript 后打开连接链接。</noscript><script>${CONNECT_SCRIPT}</script></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}
function assetlinks(env) {
  if (typeof env.ANDROID_CERT_SHA256 !== 'string' || env.ANDROID_CERT_SHA256.length > 1024) return response(404);
  const fingerprints = env.ANDROID_CERT_SHA256.split(',').map(value => value.trim().toUpperCase());
  if (!fingerprints.length || fingerprints.length > 4 || fingerprints.some(value => !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))) return response(404);
  return Response.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'com.dshphone', sha256_cert_fingerprints: [...new Set(fingerprints)],
  } }], { headers: { 'cache-control': 'public, max-age=300' } });
}

function response(status, message = 'denied') {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
function bearer(request) {
  const value = request.headers.get('authorization') || '';
  return value.startsWith('Bearer ') && value.length <= 1024 ? value.slice(7) : '';
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
function reportUnavailable(error) {
  // Only infrastructure errors reach this boundary. Keep request URLs and
  // credential-shaped values out of the live diagnostic stream.
  const message = String(error?.message || 'unknown failure')
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_=-]{24,}/g, '[redacted]')
    .slice(0, 400);
  console.error('Relay unavailable:', message);
}
async function bodyBytes(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return request.method === 'GET' ? response(200, 'ok') : response(405);
      if (url.pathname === '/connect') return request.method === 'GET' ? await connectPage() : response(405);
      if (url.pathname === '/.well-known/assetlinks.json') return request.method === 'GET' ? assetlinks(env) : response(405);
      const registration = url.pathname === '/admin/rooms';
      const removal = /^\/admin\/rooms\/([a-f0-9]{32})$/.exec(url.pathname);
      if (registration || removal) {
        if (url.search || request.method !== (registration ? 'POST' : 'DELETE')) return response(405);
        const length = request.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > (registration ? MAX_ADMIN_BODY : 0))) return response(413);
        if (!env.ADMIN_KEY || !equal(bearer(request), env.ADMIN_KEY)) return response(401);
        const bytes = await bodyBytes(request, registration ? MAX_ADMIN_BODY : 0);
        if (bytes === null) return response(413);
        if (removal) return await env.ROOMS.get(env.ROOMS.idFromName(removal[1])).fetch('https://room.internal/revoke', { method: 'DELETE', body: removal[1] });
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response(400);
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return response(400); }
        if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'proof,room' || typeof body.room !== 'string' || typeof body.proof !== 'string' || !ROOM.test(body.room) || !PROOF.test(body.proof)) return response(400);
        return await env.ROOMS.get(env.ROOMS.idFromName(body.room)).fetch('https://room.internal/register', { method: 'POST', body: JSON.stringify(body) });
      }
      if (url.pathname !== '/relay') return response(404);
      if (request.method !== 'GET') return response(405);
      const id = url.searchParams.get('room');
      if (!ROOM.test(id || '') || [...url.searchParams.keys()].join(',') !== 'room') return response(400);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return response(426);
      if (!PROOF.test(bearer(request))) return response(403);
      return await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request);
    } catch (error) { reportUnavailable(error); return response(503, 'unavailable'); }
  },
};

export class RelayRoom {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/register' && request.method === 'POST') {
      const { room, proof } = await request.json();
      const status = await this.ctx.storage.transaction(async storage => {
        const old = await storage.get('authorization');
        if (old?.proof && !equal(old.proof, proof)) return 409;
        if (old && !old.revoked) return 200;
        await storage.put('authorization', { room, proof, revoked: false, epoch: crypto.randomUUID() });
        return old ? 200 : 201;
      });
      return response(status, status === 409 ? 'conflict' : 'ok');
    }
    if (path === '/revoke' && request.method === 'DELETE') {
      const room = await request.text();
      await this.ctx.storage.transaction(async storage => {
        const old = await storage.get('authorization');
        await storage.put('authorization', { room, proof: old?.proof || null, revoked: true, epoch: crypto.randomUUID() });
      });
      for (const ws of this.ctx.getWebSockets()) this.end(ws, 1008, 'denied');
      await this.ctx.storage.deleteAlarm();
      return response(200, 'ok');
    }
    if (path !== '/relay' || request.method !== 'GET') return response(404);
    const auth = await this.ctx.storage.get('authorization');
    if (!auth || auth.revoked || !equal(bearer(request), auth.proof)) return response(403);
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS || sockets.filter(ws => ws.readyState === 1 && !this.meta(ws)?.joined).length >= MAX_PENDING) return response(429, 'busy');
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ id: crypto.randomUUID(), room: auth.room, epoch: auth.epoch, joined: false, active: true, deadline: Date.now() + JOIN_MS });
    this.ctx.acceptWebSocket(server);
    await this.updateAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  meta(ws) { return ws.deserializeAttachment(); }
  end(ws, code, reason) {
    const meta = this.meta(ws);
    if (meta) ws.serializeAttachment({ ...meta, active: false });
    try { ws.close(code, reason); } catch { /* Already closed. */ }
  }
  peer(meta) {
    return this.ctx.getWebSockets().find(ws => {
      const candidate = this.meta(ws);
      return ws.readyState === 1 && candidate?.active && candidate.joined && candidate.epoch === meta.epoch && candidate.role !== meta.role;
    });
  }
  send(ws, message) {
    if (ws?.readyState !== 1) return false;
    try { ws.send(message); return true; } catch { return false; }
  }
  signal(ws, type) { return this.send(ws, JSON.stringify({ type })); }

  async webSocketMessage(ws, message) {
    try {
      const meta = this.meta(ws);
      if (!meta?.active) return;
      const bytes = typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength;
      if (bytes > MAX_FRAME) { await this.disconnect(ws, 1009, 'too large'); return; }
      if (!meta.joined) {
        if (Date.now() >= meta.deadline || typeof message !== 'string' || bytes > MAX_JOIN) { this.end(ws, 1008, 'denied'); await this.updateAlarm(); return; }
        let join;
        try { join = JSON.parse(message); } catch { this.end(ws, 1008, 'denied'); await this.updateAlarm(); return; }
        const auth = await this.ctx.storage.get('authorization');
        if (!auth || auth.revoked || auth.epoch !== meta.epoch || join?.type !== 'join' || join.room !== meta.room || !equal(join.proof, auth.proof) || !['phone', 'computer'].includes(join.role)) {
          this.end(ws, 1008, 'denied'); await this.updateAlarm(); return;
        }
        for (const old of this.ctx.getWebSockets()) {
          const previous = this.meta(old);
          if (old !== ws && previous?.active && previous.joined && previous.role === join.role) this.end(old, 1000, 'replaced');
        }
        const joined = { ...meta, joined: true, role: join.role };
        delete joined.deadline;
        ws.serializeAttachment(joined);
        if (!this.signal(ws, 'joined')) { await this.disconnect(ws, 1011, 'unavailable'); return; }
        const other = this.peer(joined);
        if (other) {
          if (!this.signal(other, 'peer-online')) { await this.disconnect(other, 1011, 'unavailable'); return; }
          if (!this.signal(ws, 'peer-online')) { await this.disconnect(ws, 1011, 'unavailable'); return; }
        }
        await this.updateAlarm();
        return;
      }
      // Forward the original text/binary frame. No parsing, queuing or persistence.
      const other = this.peer(meta);
      if (other && !this.send(other, message)) await this.disconnect(other, 1011, 'unavailable');
    } catch { await this.disconnect(ws, 1011, 'unavailable'); }
  }

  async disconnect(ws, code, reason) {
    const meta = this.meta(ws);
    if (!meta?.active) return;
    this.end(ws, code, reason);
    if (meta.joined) {
      const other = this.peer(meta);
      if (other && !this.signal(other, 'peer-offline')) this.end(other, 1011, 'unavailable');
    }
    await this.updateAlarm();
  }
  async webSocketClose(ws) { await this.disconnect(ws, 1000, 'closed'); }
  async webSocketError(ws) { await this.disconnect(ws, 1011, 'unavailable'); }

  async updateAlarm() {
    const deadlines = this.ctx.getWebSockets().flatMap(ws => {
      const meta = this.meta(ws);
      return meta?.active && !meta.joined ? [meta.deadline] : [];
    });
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.meta(ws);
      if (meta?.active && !meta.joined && meta.deadline <= Date.now()) this.end(ws, 1008, 'denied');
    }
    await this.updateAlarm();
  }
}
