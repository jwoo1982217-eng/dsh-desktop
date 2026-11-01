import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';

export function privateIPv4(host, allowLoopback = false) {
  if (typeof host !== 'string' || isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || allowLoopback && a === 127;
}
export const validLanCandidate = (value, allowLoopback = false) => !!value && privateIPv4(value.host, allowLoopback) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535;
export const lanProof = pair => createHmac('sha256', Buffer.from(pair.secret, 'hex')).update('dsh-peer-lan-v1\0' + pair.room).digest('hex');
export function lanInterfaces() {
  try {
    return Object.entries(networkInterfaces()).filter(([name]) => !/^(?:utun|tun|tap|ppp|ipsec|docker|veth|bridge|vmnet|rmnet|ccmni|wwan|pdp)/i.test(name))
      .flatMap(([, rows]) => rows).filter(row => !row.internal && privateIPv4(row.address)).slice(0, 8);
  } catch { return []; }
}
const sign = (pair, message) => createHmac('sha256', Buffer.from(pair.secret, 'hex')).update('dsh-peer-discovery-v1\0' + JSON.stringify(message)).digest('hex');
function authenticated(pair, bytes) {
  if (bytes.length > 1024) return null;
  try {
    const value = JSON.parse(String(bytes)), { proof, ...message } = value;
    if (!/^[a-f0-9]{64}$/.test(proof) || message.v !== 1 || !/^[a-f0-9]{32}$/.test(message.nonce)) return null;
    if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(sign(pair, message), 'hex'))) return null;
    return message;
  } catch { return null; }
}
const encoded = (pair, value) => Buffer.from(JSON.stringify({ ...value, proof: sign(pair, value) }));

/** Pair-authenticated broadcast query, unicast reply; it carries no secret or UI credential. */
export function createLanDiscovery(pair, role, { port = 40831, servicePort, onCandidate, interfaces = lanInterfaces, onError = () => {} } = {}) {
  const sockets = new Set(), outstanding = new Map(), startupTimers = []; let stopped = false, timer;
  const close = () => { stopped = true; clearInterval(timer); startupTimers.forEach(clearTimeout); for (const socket of sockets) { try { socket.close(); } catch {} } sockets.clear(); outstanding.clear(); };
  const make = () => { const socket = createSocket({ type: 'udp4', reuseAddr: true }); sockets.add(socket); socket.on('error', error => { onError(error); sockets.delete(socket); try { socket.close(); } catch {} }); return socket; };
  if (role === 'computer') {
    const socket = make(); let lastReply = 0;
    socket.on('message', (bytes, info) => {
      if (stopped || !privateIPv4(info.address) || Date.now() - lastReply < 100) return;
      const message = authenticated(pair, bytes);
      if (message?.kind !== 'query') return;
      lastReply = Date.now();
      socket.send(encoded(pair, { v: 1, kind: 'offer', nonce: message.nonce, port: servicePort }), info.port, info.address, () => {});
    });
    socket.bind(port, '0.0.0.0', () => socket.unref());
  } else {
    const query = () => {
      if (stopped) return;
      const now = Date.now(); for (const [nonce, until] of outstanding) if (until < now) outstanding.delete(nonce);
      for (const row of interfaces()) {
        const socket = make(), nonce = randomBytes(16).toString('hex'); outstanding.set(nonce, now + 2500);
        socket.on('message', (bytes, info) => {
          const message = authenticated(pair, bytes);
          if (!outstanding.has(message?.nonce) || message?.kind !== 'offer') return;
          const candidate = { host: info.address, port: message.port };
          if (validLanCandidate(candidate)) onCandidate(candidate);
        });
        socket.bind(0, row.address, () => {
          if (stopped) { try { socket.close(); } catch {} return; }
          socket.unref(); socket.setBroadcast(true);
          const address = row.address.split('.').map(Number), mask = row.netmask.split('.').map(Number);
          const broadcast = address.map((part, i) => part | (255 ^ mask[i])).join('.');
          socket.send(encoded(pair, { v: 1, kind: 'query', nonce }), port, broadcast, () => {});
        });
        const timeout = setTimeout(() => { sockets.delete(socket); try { socket.close(); } catch {} }, 2600); timeout.unref();
      }
    };
    query(); for (const delay of [300, 1000, 2500]) { const timeout = setTimeout(query, delay); timeout.unref(); startupTimers.push(timeout); }
    timer = setInterval(query, 15000); timer.unref();
  }
  return { close };
}
