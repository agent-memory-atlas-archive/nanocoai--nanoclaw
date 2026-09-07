export const CHUNK = 16_384;
export const WINDOW = 65_536;
export const MAX_STREAMS = 8;
export function dataSize(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(CHUNK / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_data');
  const size = atob(value).length;
  if (!size || size > CHUNK) throw new Error('invalid_data');
  return size;
}
const live = ws => ws.readyState === 1;

// Routing state lives in socket attachments, so hibernation cannot turn a
// private SSH reply into an account-wide broadcast. No SSH payload is stored.
export class SshRelay {
  constructor(cell) { this.cell = cell; }
  peers() { return this.cell.sockets().filter(ws => live(ws) && ws.deserializeAttachment()?.leg === 'ssh'); }
  host(dev) { return this.cell.sockets().find(ws => { const a = ws.deserializeAttachment(); return live(ws) && a?.leg === 'device' && a.dev === dev; }); }
  allowed(snapshot, a) {
    const host = snapshot.devices.find(d => d.id === a.dev);
    return host?.nanocode?.enabled === true && snapshot.nanocode?.keys.some(k => k.fingerprint === a.fingerprint && k.deviceId === a.client);
  }
  open(ws, claims) {
    const id = crypto.randomUUID();
    ws.serializeAttachment({ ...claims, id, clientSent: 0, clientAcked: 0, hostSent: 0, hostAcked: 0, lastSeen: Date.now() });
    this.cell.send(this.host(claims.dev), { type: 'ssh.open', id, client: claims.client, fingerprint: claims.fingerprint });
  }
  close(ws, reason = 'closed') {
    const a = ws.deserializeAttachment();
    if (a?.leg === 'ssh') {
      this.cell.send(this.host(a.dev), { type: 'ssh.close', id: a.id });
      try { ws.close(4000, reason); } catch {}
    } else if (a?.leg === 'device') {
      for (const peer of this.peers()) if (peer.deserializeAttachment().dev === a.dev) this.close(peer, 'host disconnected');
    }
  }
  revoke(snapshot) { for (const peer of this.peers()) if (!this.allowed(snapshot, peer.deserializeAttachment())) this.close(peer, 'access revoked'); }
  message(ws, message) {
    const source = ws.deserializeAttachment();
    const fromHost = source.leg === 'device';
    const peer = fromHost ? this.peers().find(p => { const a = p.deserializeAttachment(); return a.id === message.id && a.dev === source.dev; }) : ws;
    if (!['device', 'ssh'].includes(source.leg)) throw new Error('unknown_stream');
    // Close/ACK can race stream retirement. Unknown IDs never route anywhere.
    if (!peer) return;
    const a = peer.deserializeAttachment(), host = this.host(a.dev);
    if (!host) { this.close(peer, 'host offline'); return; }
    if (message.type === 'ssh.close') { this.close(peer); return; }
    if (message.type === 'ssh.ready' && fromHost && !a.ready) {
      peer.serializeAttachment({ ...a, ready: true }); this.cell.send(peer, { type: 'ssh.ready' }); return;
    }
    if (!a.ready) throw new Error('stream_not_ready');
    const sender = fromHost ? 'host' : 'client', other = fromHost ? 'client' : 'host';
    if (message.type === 'ssh.data') {
      const size = dataSize(message.data);
      if (message.seq !== a[`${sender}Sent`] || message.seq + size - a[`${sender}Acked`] > WINDOW) throw new Error('flow_control');
      a[`${sender}Sent`] += size;
    } else if (message.type === 'ssh.ack') {
      if (!Number.isSafeInteger(message.seq) || message.seq < a[`${other}Acked`] || message.seq > a[`${other}Sent`]) throw new Error('flow_control');
      a[`${other}Acked`] = message.seq;
    } else throw new Error('invalid_frame');
    peer.serializeAttachment(a);
    this.cell.send(fromHost ? peer : host, { type: message.type, id: a.id, seq: message.seq, ...(message.type === 'ssh.data' ? { data: message.data } : {}) });
  }
}
