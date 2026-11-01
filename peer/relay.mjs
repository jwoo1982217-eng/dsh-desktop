import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_FRAME } from './protocol.mjs';

// The relay forwards opaque, authenticated ciphertext. It has no model keys,
// file access, or DSH execution API. Put it behind an HTTPS/WebSocket proxy.
export function createRelay({ maxRooms = 100, maxConnections = 250, handleRequest, admit } = {}) {
  const rooms = new Map();
  const server = createServer((req, res) => {
    if (handleRequest) { void Promise.resolve().then(() => handleRequest(req, res)).catch(() => { if (!res.headersSent) res.writeHead(503); res.end('unavailable'); }); return; }
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(req.url === '/health' ? 'DSH relay ready' : 'Not found');
  });
  // Keep HTTP listen errors on the owned server so callers can handle them;
  // ws's server mode would forward them to an unhandled WebSocketServer error.
  const sockets = new WebSocketServer({ noServer: true, path: '/relay', maxPayload: MAX_FRAME, perMessageDeflate: false });
  const upgrade = (req, socket, head) => {
    let admission;
    if (admit) {
      try { admission = admit(req); } catch { /* Fail closed. */ }
      if (!admission) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    }
    sockets.handleUpgrade(req, socket, head, ws => { ws.admission = admission; sockets.emit('connection', ws, req); });
  };
  server.on('upgrade', upgrade);
  sockets.on('connection', (ws, req) => {
    if (sockets.clients.size > maxConnections) { ws.close(1013, 'capacity'); return; }
    let room, role, joined = false, alive = true;
    const deadline = setTimeout(() => ws.close(1008, 'join required'), 5000); deadline.unref();
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    ws.on('message', (bytes, binary) => {
      if (!joined) {
        try {
          if (binary || bytes.length > 2048) throw Error();
          const j = JSON.parse(bytes.toString());
          if (j.type !== 'join' || !/^[a-f0-9]{32}$/.test(j.room) || !/^[a-f0-9]{64}$/.test(j.proof) || !['phone', 'computer'].includes(j.role)) throw Error();
          if (ws.admission && (!admit(req) || j.room !== ws.admission.room || j.proof !== ws.admission.proof)) throw Error();
          room = rooms.get(j.room);
          if (!room) {
            if (rooms.size >= maxRooms) throw Error();
            room = { id: j.room, proof: j.proof, phone: null, computer: null }; rooms.set(j.room, room);
          }
          if (!timingSafeEqual(Buffer.from(room.proof, 'hex'), Buffer.from(j.proof, 'hex'))) throw Error();
          role = j.role; const previous = room[role]; room[role] = ws; joined = true; clearTimeout(deadline);
          // A reconnect proves the same room secret. Retire its stale socket;
          // the close handler below cannot clear the replacement.
          if (previous && previous !== ws) previous.terminate();
          ws.send(JSON.stringify({ type: 'joined' }));
          const other = room[role === 'phone' ? 'computer' : 'phone'];
          if (other?.readyState === WebSocket.OPEN) {
            other.send(JSON.stringify({ type: 'peer-online' })); ws.send(JSON.stringify({ type: 'peer-online' }));
          }
        } catch { ws.close(1008, 'join denied'); }
        return;
      }
      const other = room[role === 'phone' ? 'computer' : 'phone'];
      if (other?.readyState !== WebSocket.OPEN) return;
      if (other.bufferedAmount > MAX_FRAME * 4) { ws.close(1013, 'slow peer'); return; }
      other.send(bytes, { binary });
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (room?.[role] !== ws) return;
      room[role] = null;
      const other = room[role === 'phone' ? 'computer' : 'phone'];
      if (other?.readyState === WebSocket.OPEN) other.send(JSON.stringify({ type: 'peer-offline' }));
      if (!room.phone && !room.computer) rooms.delete(room.id);
    });
    ws.isAlive = () => alive; ws.setAlive = value => { alive = value; };
  });
  const heartbeat = setInterval(() => { for (const ws of sockets.clients) { if (!ws.isAlive?.()) ws.terminate(); else { ws.setAlive(false); ws.ping(); } } }, 20000); heartbeat.unref();
  return { server, rooms, dropRoom(id) { for (const ws of sockets.clients) if (ws.admission?.room === id) ws.terminate(); }, async close() { clearInterval(heartbeat); server.off('upgrade', upgrade); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelay();
  const port = Number(process.env.DSH_RELAY_PORT ?? 8789), host = process.env.DSH_RELAY_HOST ?? '127.0.0.1';
  relay.server.listen(port, host, () => process.stdout.write(`DSH relay listening on ${host}:${port}; publish /relay through TLS\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void relay.close(); });
}
