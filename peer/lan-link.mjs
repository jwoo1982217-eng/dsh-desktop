import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { PeerTunnel } from './tunnel.mjs?lan-v1';
import { createRelay } from './relay.mjs';
import { createLanDiscovery, lanInterfaces, lanProof, privateIPv4, validLanCandidate } from './lan-network.mjs';
export { validLanCandidate } from './lan-network.mjs';

const LIMIT = 8 * 1024 * 1024;
const epoch = () => randomBytes(16).toString('hex');
const epochValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

/** One UI transport, two encrypted carriers. Route changes preserve ordered, once-only delivery. */
export class LanPeerTunnel extends EventEmitter {
  constructor(pair, role, options = {}) {
    super(); this.pair = pair; this.role = role; this.options = options; this.lan = options.lan ?? {};
    this.epoch = epoch(); this.remoteEpoch = null; this.sent = 0; this.received = 0;
    this.outbox = new Map(); this.reorder = new Map(); this.bytes = 0; this.reorderBytes = 0;
    this.pending = new Map(); this.activeCalls = 0; this.generation = 0; this.stopped = false;
    this.online = false; this.phase = 'idle'; this.errorCode = ''; this.route = 'offline'; this.modes = new Map();
    this.lanCandidates = []; this.candidates = []; this.lanPeers = new Set();
    this.relay = this.attach(new PeerTunnel(pair, role, options), 'relay');
    const key = createHash('sha256').update(pair.room + '/' + pair.secret).digest('hex').slice(0, 24);
    this.cacheFile = this.lan.cacheFile === false ? null : this.lan.cacheFile ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storage', 'peer-lan', key + '.json');
  }
  get routes() { return [...new Set([...this.modes].filter(([peer]) => peer.online).map(([peer]) => peer.linkRoute))]; }
  get socket() { return this.current?.socket; }
  attach(peer, route) {
    peer.linkRoute = route;
    peer.handler = (action, value) => {
      if (action === 'link.hello' && value?.version === 1 && epochValid(value.epoch)) {
        this.accept(peer, value.epoch, 'ordered'); return { version: 1, epoch: this.epoch };
      }
      return this.handler?.(action, value);
    };
    peer.on('online', () => {
      void peer.call('link.hello', { version: 1, epoch: this.epoch }, 2500).then(value => {
        if (!peer.online || this.stopped) return;
        if (value?.version === 1 && epochValid(value.epoch)) this.accept(peer, value.epoch, 'ordered');
        else this.accept(peer, null, 'legacy');
      }, () => { if (peer.online && !this.stopped && !this.modes.has(peer)) this.accept(peer, null, 'legacy'); });
      if (route === 'relay') this.offer();
    });
    peer.on('packet', packet => {
      if (packet.type === 'link.candidates') { if (this.role === 'phone') this.addLanCandidates(packet.candidates); return; }
      if (packet.type === 'link.frame' || packet.type === 'link.ack') { this.receive(peer, packet); return; }
      if (this.modes.get(peer)?.mode === 'legacy') this.emit('packet', packet);
    });
    peer.on('offline', () => { this.modes.delete(peer); this.update(); });
    peer.on('state', status => {
      if (!this.online && route === 'relay') { this.phase = status.phase; this.errorCode = status.errorCode; this.emit('state', status); }
    });
    return peer;
  }
  accept(peer, remoteEpoch, mode) {
    if (this.stopped || !peer.online) return;
    if (mode === 'ordered' && this.remoteEpoch && this.remoteEpoch !== remoteEpoch) {
      // A new process cannot acknowledge or replay operations from the previous process.
      this.reset(); this.modes.clear();
    }
    if (remoteEpoch) this.remoteEpoch = remoteEpoch;
    this.modes.set(peer, { mode, epoch: remoteEpoch }); this.update();
    if (peer === this.relay) this.offer();
    if (peer.linkRoute === 'lan' && this.role === 'phone') void this.saveCandidates();
  }
  update() {
    const previous = this.current;
    this.current = [...this.lanPeers, this.relay].find(peer => peer?.online && this.modes.has(peer));
    const route = this.current?.linkRoute ?? 'offline';
    if (route === 'lan') this.lanPeer = this.current;
    const wasOnline = this.online; this.online = !!this.current; this.remote = this.online ? (this.role === 'phone' ? 'computer' : 'phone') : null;
    if (!this.online) {
      if (wasOnline) { this.reset(); this.epoch = epoch(); this.remoteEpoch = null; this.emit('offline'); }
      this.route = route; return;
    }
    this.phase = 'online'; this.errorCode = ''; this.route = route;
    if (!wasOnline) { this.generation++; this.emit('online'); }
    if (previous !== this.current) { this.emit('route', { route }); this.flush(); }
    this.emit('state', { phase: 'online', errorCode: '', route });
  }
  reset() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('远程连接已断开；未自动重复提交任务')); }
    this.pending.clear(); this.outbox.clear(); this.reorder.clear(); this.bytes = 0; this.reorderBytes = 0; this.sent = 0; this.received = 0;
  }
  send(message) {
    if (!this.online || !this.current) throw Error('远程设备未连接');
    if (this.modes.get(this.current)?.mode === 'legacy') return this.current.send(message);
    const size = Buffer.byteLength(JSON.stringify(message));
    if (this.bytes + size > LIMIT || this.outbox.size >= 1024) throw Error('远程连接拥堵，请稍后重试');
    const sequence = ++this.sent, frame = { type: 'link.frame', epoch: this.epoch, target: this.remoteEpoch, sequence, message };
    this.outbox.set(sequence, { frame, size }); this.bytes += size;
    try { this.current.send(frame); } catch (error) { this.outbox.delete(sequence); this.bytes -= size; this.sent--; throw error; }
  }
  flush() {
    if (!this.current || this.modes.get(this.current)?.mode !== 'ordered') return;
    for (const { frame } of this.outbox.values()) { try { this.current.send(frame); } catch { break; } }
  }
  acknowledge(peer) {
    const carrier = this.current ?? peer;
    try { carrier.send({ type: 'link.ack', epoch: this.epoch, target: this.remoteEpoch, sequence: this.received }); } catch {}
  }
  receive(peer, frame) {
    if (frame.target !== this.epoch || frame.epoch !== this.remoteEpoch || this.modes.get(peer)?.mode !== 'ordered') return;
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return;
    if (frame.type === 'link.ack') {
      if (frame.sequence > this.sent) return;
      for (const [seq, value] of this.outbox) { if (seq > frame.sequence) break; this.bytes -= value.size; this.outbox.delete(seq); }
      return;
    }
    if (frame.sequence <= this.received) { this.acknowledge(peer); return; }
    if (frame.sequence > this.received + 1024 || !frame.message) return;
    if (!this.reorder.has(frame.sequence)) {
      const size = Buffer.byteLength(JSON.stringify(frame.message));
      if (this.reorderBytes + size > LIMIT) { peer.retire('PEER_PROTOCOL', true); return; }
      this.reorder.set(frame.sequence, { message: frame.message, size }); this.reorderBytes += size;
    }
    while (this.reorder.has(this.received + 1)) {
      const value = this.reorder.get(++this.received); this.reorder.delete(this.received); this.reorderBytes -= value.size; this.dispatch(value.message);
    }
    this.acknowledge(peer);
  }
  dispatch(message) {
    if (message.type === 'reply') {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value); else pending.reject(Error(message.error || '远程操作失败')); return;
    }
    if (message.type !== 'call') { this.emit('packet', message); return; }
    if (this.activeCalls >= 64 || typeof message.id !== 'string' || message.id.length > 64 || typeof message.action !== 'string') return;
    const ownEpoch = this.epoch, otherEpoch = this.remoteEpoch; this.activeCalls++;
    const reply = result => { if (this.online && ownEpoch === this.epoch && otherEpoch === this.remoteEpoch) this.send({ type: 'reply', id: message.id, ...result }); };
    Promise.resolve().then(() => this.handler?.(message.action, message.value)).then(value => reply({ ok: true, value }), () => reply({ ok: false, error: '远程操作失败，请检查连接和配置' })).catch(() => {}).finally(() => this.activeCalls--);
  }
  call(action, value, timeout = 30000) {
    if (!this.online) return Promise.reject(Error('远程设备离线，请保持两端 DSH 运行'));
    if (this.modes.get(this.current)?.mode === 'legacy') return this.current.call(action, value, timeout);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('远程请求超时')); }, timeout); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'call', id, action, value }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  start() {
    if (this.started || this.stopped) return; this.started = true; this.relay.start();
    this.retryTimer = setInterval(() => this.flush(), 2000); this.retryTimer.unref();
    if (this.lan.enabled === false) return;
    if (this.role === 'computer') void this.listenLan().catch(() => { this.lanError = 'PEER_LAN_UNAVAILABLE'; });
    else {
      void this.loadCandidates();
      if (this.lan.discovery !== false) this.discovery = createLanDiscovery(this.pair, 'phone', { onCandidate: candidate => this.addLanCandidates([candidate]), onError: () => { this.lanError = 'PEER_LAN_DISCOVERY'; } });
    }
  }
  async listenLan() {
    const proof = lanProof(this.pair);
    const relay = this.lanRelay = createRelay({ maxRooms: 1, maxConnections: 8, admit: req => {
      const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (!privateIPv4(address, true) || req.headers.authorization !== 'Bearer ' + proof) return null;
      return { room: this.pair.room, proof };
    } });
    await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '0.0.0.0', resolve); });
    if (this.stopped) { await relay.close(); return; }
    const port = relay.server.address().port;
    const addresses = this.lan.addresses?.() ?? lanInterfaces().map(row => row.address);
    this.lanCandidates = addresses.slice(0, 8).map(host => ({ host, port })).filter(value => validLanCandidate(value, this.lan.allowLoopback));
    this.lanPeer = this.attach(new PeerTunnel(this.pair, this.role, { ...this.options, endpoint: `ws://127.0.0.1:${port}/relay`, proof, routeFor: async () => ({ proxied: false }) }), 'lan');
    this.lanPeers.add(this.lanPeer); this.lanPeer.start(); this.offer();
    if (this.lan.discovery !== false) this.discovery = createLanDiscovery(this.pair, 'computer', { servicePort: port, onError: () => { this.lanError = 'PEER_LAN_DISCOVERY'; } });
    this.offerTimer = setInterval(() => this.offer(), 15000); this.offerTimer.unref();
  }
  offer() {
    if (this.role !== 'computer') return;
    const port = this.lanRelay?.server.address()?.port;
    if (port) this.lanCandidates = (this.lan.addresses?.() ?? lanInterfaces().map(row => row.address)).slice(0, 8).map(host => ({ host, port })).filter(value => validLanCandidate(value, this.lan.allowLoopback));
    if (this.relay.online && this.lanCandidates.length) { try { this.relay.send({ type: 'link.candidates', candidates: this.lanCandidates }); } catch {} }
  }
  addLanCandidates(values) {
    if (this.stopped || this.role !== 'phone' || this.lan.enabled === false || !Array.isArray(values)) return;
    for (const value of values.slice(0, 8)) if (validLanCandidate(value, this.lan.allowLoopback) && !this.candidates.some(row => row.host === value.host && row.port === value.port)) this.candidates.push({ host: value.host, port: value.port });
    this.candidates = this.candidates.slice(-8);
    if ([...this.lanPeers].some(peer => peer.online) || !this.candidates.length) return;
    const preferred = this.candidates.slice(-4).reverse().map(candidate => `ws://${candidate.host}:${candidate.port}/relay`);
    for (const peer of this.lanPeers) if (peer.stopped || !preferred.includes(peer.endpoint)) { peer.stop(); this.lanPeers.delete(peer); this.modes.delete(peer); }
    for (const endpoint of preferred) {
      if ([...this.lanPeers].some(peer => peer.endpoint === endpoint)) continue;
      const peer = this.attach(new PeerTunnel(this.pair, this.role, { ...this.options, endpoint, proof: lanProof(this.pair), routeFor: async () => ({ proxied: false }), handshakeTimeoutMs: 1200 }), 'lan');
      this.lanPeers.add(peer); this.lanPeer = peer; peer.start();
    }
  }
  async loadCandidates() {
    if (!this.cacheFile) return;
    try { const saved = JSON.parse(await readFile(this.cacheFile, 'utf8')); if (Date.now() - saved.at < 7 * 86400000) this.addLanCandidates(saved.candidates); } catch {}
  }
  async saveCandidates() {
    if (!this.cacheFile) return;
    if (this.cacheFlight) return this.cacheFlight;
    this.cacheFlight = (async () => {
      try { await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 }); const temp = this.cacheFile + '.' + randomUUID(); await writeFile(temp, JSON.stringify({ at: Date.now(), candidates: this.candidates }), { mode: 0o600 }); await rename(temp, this.cacheFile); } catch {}
    })().finally(() => { this.cacheFlight = null; });
    return this.cacheFlight;
  }
  reconnect() { if (!this.stopped) { this.relay.reconnect(); for (const peer of this.lanPeers) peer.reconnect(); } }
  async stop() {
    if (this.stopped) return; this.stopped = true; clearInterval(this.retryTimer); clearInterval(this.offerTimer); this.discovery?.close();
    this.relay.stop(); for (const peer of this.lanPeers) peer.stop(); this.modes.clear(); this.update(); this.reset(); this.phase = 'stopped';
    if (this.lanRelay?.server.listening) await this.lanRelay.close();
  }
}
